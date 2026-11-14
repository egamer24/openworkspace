import {
  oauthScopeAnyOf,
  requireAuth,
  requestPermissions,
  createDb,
  mailboxAddressSql,
  mailboxKind,
  mailboxKindOrderSql,
  mailboxAccess,
  mailboxes,
  apiError,
  zValidator,
} from "@open-workspace/core/module";
import type { Database, AppEnv } from "@open-workspace/core/module";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import type { ImportPlacement } from "../../shared/mail-import";
import {
  importPlacements,
  MAX_IMPORT_KEY_LENGTH,
  MAX_IMPORT_MESSAGE_BYTES,
} from "../../shared/mail-import";
import {
  IMPORT_MAIL,
  IMPORT_MAIL_SCOPE,
  MAIL_ORGANIZE_SCOPE,
} from "../../shared/permissions";
import { mailboxStub } from "../mailbox";
import type { ImportMessageResult } from "../mailbox";
import { readCappedBody } from "./capped-body";
import { rawMessageId } from "./inbound";

/**
 * Importing existing mail (the `open-workspace import` CLI).
 *
 * Who may import where:
 * - A person holding the "Import mail" permission (`import_mail`; every
 *   administrator) may import into any mailbox, personal or team. An app
 *   needs the `admin.import_mail` scope for that.
 * - Anyone else may import only into their own personal mailboxes (those
 *   they own, primary or not), not into team mailboxes they share: imported
 *   mail is shown as received, so only its owner may add to it. An app
 *   needs `mail.organize` for that.
 */

const importQuerySchema = z.object({
  /** The message's id at its source; importing the same id again does nothing. */
  sourceId: z.string().min(1).max(MAX_IMPORT_KEY_LENGTH),
  placement: z.enum(importPlacements).default("inbox"),
  /** A custom folder for a message in the Inbox, created when missing. */
  folder: z.string().trim().min(1).max(80).optional(),
  /** "1" when the message was read (for everyone who can open the mailbox). */
  seen: z.enum(["0", "1"]).default("0"),
  /** The source's thread id: messages with the same key are one conversation. */
  thread: z.string().min(1).max(MAX_IMPORT_KEY_LENGTH).optional(),
  /** When the message was received: epoch ms or an ISO date; else its Date header. */
  receivedAt: z
    .string()
    .max(40)
    .optional()
    .transform((value, context) => {
      if (value === undefined) return null;
      const time = /^\d+$/u.test(value) ? Number(value) : Date.parse(value);

      if (!Number.isFinite(time)) {
        context.addIssue({
          code: "custom",
          message: "receivedAt must be epoch milliseconds or an ISO date",
        });

        return z.NEVER;
      }

      return time;
    }),
  /** Without it, mail from the mailbox's own address counts as sent. */
  direction: z.enum(["incoming", "outgoing"]).optional(),
});

async function sha256Hex(value: string | Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    value instanceof Uint8Array ? value : new TextEncoder().encode(value)
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Stores one raw message in a mailbox as an import: kept once per
 * `importKey` (and per Message-ID), read for everyone who can open the
 * mailbox when `seen`, threaded by `thread` when given.
 */
export async function importRawMessage(input: {
  env: Env;
  mailbox: { id: string; address: string };
  raw: Uint8Array;
  /** The message's id at its source (or its bytes); importing it again does nothing. */
  importKey: string | Uint8Array<ArrayBuffer>;
  receivedAt: number | null;
  placement: ImportPlacement;
  folderName: string | null;
  seen: boolean;
  thread: string | null;
  direction: "incoming" | "outgoing" | null;
}): Promise<ImportMessageResult> {
  const { env, mailbox: target, raw } = input;
  const mailbox = mailboxStub(env, target.id);
  const importId = `imp_${(await sha256Hex(input.importKey)).slice(0, 32)}`;
  const known = await mailbox.findImported(importId, rawMessageId(raw));

  if (known) return { status: "duplicate", ...known };
  const rawObjectKey = `mailboxes/${target.id}/raw/${importId}.eml`;
  await env.MAIL_STORAGE.put(rawObjectKey, raw, {
    httpMetadata: { contentType: "message/rfc822" },
  });

  const seenBy = input.seen
    ? (
        await createDb(env.DB)
          .select({ userId: mailboxAccess.userId })
          .from(mailboxAccess)
          .where(eq(mailboxAccess.mailboxId, target.id))
      ).map((row) => row.userId)
    : [];

  return mailbox.importMessage({
    importId,
    rawObjectKey,
    mailboxAddress: target.address,
    receivedAt: input.receivedAt,
    placement: input.placement,
    folderName: input.folderName,
    seenBy,
    conversationId: input.thread
      ? `conv_imp_${(await sha256Hex(input.thread)).slice(0, 32)}`
      : null,
    direction: input.direction,
  });
}

/** A mailbox's import target: where it is and who can open it. */
async function importMailbox(db: Database, mailboxId: string) {
  const [mailbox] = await db
    .select({
      id: mailboxes.id,
      address: mailboxAddressSql,
      ownerUserId: mailboxes.ownerUserId,
    })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .limit(1);

  return mailbox ?? null;
}

/**
 * Whether this request may import into any mailbox, not just the person's
 * own: the person holds the permission and, for an app, so does its token.
 */
function importsAnywhere(c: Context<AppEnv>) {
  return requestPermissions(c).includes(IMPORT_MAIL);
}

/** Whether an app's token may import into its person's own mailboxes. */
function organizes(c: Context<AppEnv>) {
  return (
    c.get("authKind") !== "oauth" ||
    c.get("oauthScopes").includes(MAIL_ORGANIZE_SCOPE)
  );
}

/** The mailbox if this request may import into it, else the refusal. */
async function authorizedMailbox(c: Context<AppEnv>, mailboxId: string) {
  const mailbox = await importMailbox(createDb(c.env.DB), mailboxId);

  if (
    mailbox &&
    (importsAnywhere(c) ||
      (mailbox.ownerUserId === c.get("user").id && organizes(c)))
  ) {
    return mailbox;
  }

  return apiError(
    c,
    403,
    "FORBIDDEN",
    "You may not import mail into this mailbox"
  );
}

class TooLargeError extends Error {}

/** The request body, refusing one larger than `limit` without reading it all. */
async function boundedBody(request: Request, limit: number) {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);

  if (declared > limit) throw new TooLargeError();

  if (!request.body) return new Uint8Array();
  const body = await readCappedBody(request.body, limit);

  if (!body) throw new TooLargeError();

  return body;
}

export const mailImportRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .use("*", oauthScopeAnyOf(MAIL_ORGANIZE_SCOPE, IMPORT_MAIL_SCOPE))
  /** The mailboxes this request may import into, for mapping source accounts to them. */
  .get("/mailboxes", async (c) => {
    const db = createDb(c.env.DB);
    const anywhere = importsAnywhere(c);

    if (!anywhere && !organizes(c)) {
      return c.json({ ok: true as const, mailboxes: [] });
    }

    const rows = await db
      .select({
        id: mailboxes.id,
        address: mailboxAddressSql,
        displayName: mailboxes.displayName,
        ownerUserId: mailboxes.ownerUserId,
        teamId: mailboxes.teamId,
        delivery: mailboxes.delivery,
      })
      .from(mailboxes)
      .where(anywhere ? undefined : eq(mailboxes.ownerUserId, c.get("user").id))
      .orderBy(mailboxKindOrderSql, mailboxAddressSql);

    return c.json({
      ok: true as const,
      mailboxes: rows
        // A mailing list keeps no mail of its own.
        .filter((row) => row.delivery === "inbox")
        .map((row) => ({
          id: row.id,
          address: row.address,
          displayName: row.displayName,
          kind: mailboxKind(row.ownerUserId),
          ownerUserId: row.ownerUserId,
          teamId: row.teamId,
        })),
    });
  })
  .post(
    "/mailboxes/:id/messages",
    zValidator("query", importQuerySchema),
    async (c) => {
      const target = await authorizedMailbox(c, c.req.param("id"));

      if (target instanceof Response) return target;
      const input = c.req.valid("query");
      let raw: Uint8Array;

      try {
        raw = await boundedBody(c.req.raw, MAX_IMPORT_MESSAGE_BYTES);
      } catch (error) {
        if (!(error instanceof TooLargeError)) throw error;

        return apiError(
          c,
          413,
          "TOO_LARGE",
          `Messages are limited to ${MAX_IMPORT_MESSAGE_BYTES / 1024 / 1024} MiB, the size Email Routing delivers`
        );
      }

      if (!raw.byteLength) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "The body must be the raw message (message/rfc822)"
        );
      }

      const result = await importRawMessage({
        env: c.env,
        mailbox: target,
        raw,
        importKey: input.sourceId,
        receivedAt: input.receivedAt,
        placement: input.placement,
        folderName: input.folder ?? null,
        seen: input.seen === "1",
        thread: input.thread ?? null,
        direction: input.direction ?? null,
      });

      if (result.status === "unprocessable") {
        return apiError(
          c,
          422,
          "UNPROCESSABLE",
          `The message could not be read: ${result.reason}`
        );
      }

      if (result.status === "duplicate") {
        return c.json({
          ok: true as const,
          duplicate: true as const,
          id: result.id,
          conversationId: result.conversationId,
        });
      }

      return c.json(
        {
          ok: true as const,
          duplicate: false as const,
          id: result.id,
          conversationId: result.conversationId,
          folderSkipped: result.folderSkipped,
        },
        201
      );
    }
  )
  /**
   * Announces what was imported (inbox counts, open apps, JMAP state) once.
   * Imports announce themselves within seconds anyway; this does it now.
   */
  .post("/mailboxes/:id/finish", async (c) => {
    const target = await authorizedMailbox(c, c.req.param("id"));

    if (target instanceof Response) return target;
    const { version } = await mailboxStub(c.env, target.id).finishImport();

    return c.json({ ok: true as const, version });
  });
