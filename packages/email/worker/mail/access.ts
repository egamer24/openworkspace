import {
  createDb,
  mailboxAccess,
  mailboxes,
  sessions,
  mailboxAddressSql,
  mailboxKind,
  mailboxKindOrderSql,
  timed,
} from "@open-workspace/core/module";
import type {
  SessionCompanion,
  AppEnv,
  Database,
} from "@open-workspace/core/module";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";

import { mailboxCounts, mailboxReadCounts, signatures } from "../db/schema";

const accessColumns = {
  id: mailboxes.id,
  address: mailboxAddressSql,
  displayName: mailboxes.displayName,
  ownerUserId: mailboxes.ownerUserId,
  canSend: mailboxAccess.canSend,
};

/**
 * With the inbox counts each mailbox's Durable Object keeps in D1 (joined by
 * `withInboxCounts`); a mailbox without a row has had no mail yet.
 */
const listColumns = {
  ...accessColumns,
  isPrimary: mailboxes.isPrimary,
  unreadCount:
    sql<number>`max(0, coalesce(${mailboxCounts.incomingCount}, 0) - coalesce(${mailboxReadCounts.readCount}, 0))`.as(
      "unread_count"
    ),
  version: sql<number>`coalesce(${mailboxCounts.version}, 0)`.as(
    "counts_version"
  ),
  signatureUserId: signatures.userId,
  signatureMailboxId: signatures.mailboxId,
  signatureHtml: signatures.html,
  signatureUseOnNew: signatures.useOnNew,
  signatureUseOnReply: signatures.useOnReply,
};

const inboxCountsJoin = eq(mailboxCounts.mailboxId, mailboxAccess.mailboxId);

const readCountsJoin = and(
  eq(mailboxReadCounts.mailboxId, mailboxAccess.mailboxId),
  eq(mailboxReadCounts.userId, mailboxAccess.userId)
);

/**
 * The signature sending from each mailbox adds: a team address's own, or the
 * listing person's for their own mailbox (signatures.ts, signatureOwner).
 */
const signatureJoin = or(
  and(isNull(mailboxes.ownerUserId), eq(signatures.mailboxId, mailboxes.id)),
  and(
    eq(mailboxes.ownerUserId, mailboxAccess.userId),
    eq(signatures.userId, mailboxAccess.userId)
  )
);

const listOrder = [
  mailboxKindOrderSql,
  desc(mailboxes.isPrimary),
  mailboxes.displayName,
] as const;

const accessRowSchema = z.object({
  id: z.string(),
  address: z.string(),
  displayName: z.string(),
  ownerUserId: z.string().nullable(),
  canSend: z.boolean(),
});

type AccessRow = z.infer<typeof accessRowSchema>;

export const mailboxListRowSchema = accessRowSchema.extend({
  isPrimary: z.boolean(),
  unreadCount: z.number(),
  version: z.number(),
  signatureUserId: z.string().nullable(),
  signatureMailboxId: z.string().nullable(),
  signatureHtml: z.string().nullable(),
  signatureUseOnNew: z.boolean().nullable(),
  signatureUseOnReply: z.boolean().nullable(),
});

export type MailboxListRow = z.infer<typeof mailboxListRowSchema>;

function withKind(access: AccessRow | undefined) {
  return access ? { ...access, kind: mailboxKind(access.ownerUserId) } : null;
}

function accessQuery(db: Database, userId: string, mailboxId: string) {
  return db
    .select(accessColumns)
    .from(mailboxAccess)
    .innerJoin(mailboxes, eq(mailboxAccess.mailboxId, mailboxes.id))
    .where(
      and(
        eq(mailboxAccess.userId, userId),
        eq(mailboxAccess.mailboxId, mailboxId)
      )
    )
    .limit(1);
}

function listQuery(db: Database, userId: string) {
  return db
    .select(listColumns)
    .from(mailboxAccess)
    .innerJoin(mailboxes, eq(mailboxAccess.mailboxId, mailboxes.id))
    .leftJoin(mailboxCounts, inboxCountsJoin)
    .leftJoin(mailboxReadCounts, readCountsJoin)
    .leftJoin(signatures, signatureJoin)
    .where(eq(mailboxAccess.userId, userId))
    .orderBy(...listOrder);
}

function sessionScope(tokenHash: string, now: Date) {
  return and(
    eq(sessions.userId, mailboxAccess.userId),
    eq(sessions.tokenHash, tokenHash),
    gt(sessions.expiresAt, now)
  );
}

/**
 * The mailbox list (with inbox counts) of the session with `tokenHash`, for
 * a session lookup's batch; rows are meaningful only if core accepts it.
 */
export function sessionMailboxListQuery(
  db: Database,
  tokenHash: string,
  now: Date
) {
  return db
    .select(listColumns)
    .from(mailboxAccess)
    .innerJoin(sessions, sessionScope(tokenHash, now))
    .innerJoin(mailboxes, eq(mailboxAccess.mailboxId, mailboxes.id))
    .leftJoin(mailboxCounts, inboxCountsJoin)
    .leftJoin(mailboxReadCounts, readCountsJoin)
    .leftJoin(signatures, signatureJoin)
    .orderBy(...listOrder);
}

export async function getMailboxAccess(
  db: Database,
  userId: string,
  mailboxId: string
) {
  const [access] = await accessQuery(db, userId, mailboxId);

  return withKind(access);
}

/** Mailboxes a person can open, personal first, then primary, then by name. */
export function listAccessibleMailboxes(
  db: Database,
  userId: string
): Promise<MailboxListRow[]> {
  return listQuery(db, userId).all();
}

type MailboxTarget = { kind: "list" } | { kind: "mailbox"; mailboxId: string };

/**
 * The mailbox a mail API request is about, read from the URL the way the
 * routes read it: `/mail/mailboxes` (the list), `/mail/mailboxes/:id/...`, or
 * a `mailboxId` query parameter.
 */
function mailboxTarget(c: Context<AppEnv>): MailboxTarget | null {
  const match = /^(?:\/api)?\/mail\/mailboxes(?:\/([^/]+))?\/?/u.exec(
    c.req.path
  );

  if (match && !match[1]) {
    return c.req.method === "GET" && /\/mailboxes\/?$/u.test(c.req.path)
      ? { kind: "list" }
      : null;
  }

  const raw = match?.[1] ?? c.req.query("mailboxId");

  if (!raw) return null;

  try {
    return {
      kind: "mailbox",
      mailboxId: match?.[1] ? decodeURIComponent(raw) : raw,
    };
  } catch {
    return null;
  }
}

/**
 * Runs the request's mailbox authorization in the session lookup's D1 batch.
 * The statements are scoped to the session's own token (and expiry), and
 * their rows are used only after core accepted that same session, so the
 * outcome matches a separate query made after authentication.
 */
export const mailAccessCompanion: SessionCompanion = ({
  c,
  db,
  tokenHash,
  now,
}) => {
  const target = mailboxTarget(c);

  if (!target) return null;

  if (target.kind === "list") {
    return sessionMailboxListQuery(db, tokenHash, now);
  }

  return db
    .select(accessColumns)
    .from(mailboxAccess)
    .innerJoin(sessions, sessionScope(tokenHash, now))
    .innerJoin(mailboxes, eq(mailboxAccess.mailboxId, mailboxes.id))
    .where(eq(mailboxAccess.mailboxId, target.mailboxId))
    .limit(1);
};

/**
 * The rows the session batch ran for this request (mailAccessCompanion),
 * parsed with `schema`: core hands them over untyped.
 */
function preloadedRows<Row>(
  c: Context<AppEnv>,
  matches: (target: MailboxTarget) => boolean,
  schema: z.ZodType<Row>
) {
  if (c.get("authKind") !== "session") return undefined;
  const target = mailboxTarget(c);

  if (!target || !matches(target)) return undefined;
  const rows = z.array(schema).safeParse(c.get("authCompanion"));

  return rows.success ? rows.data : undefined;
}

/** The signed-in person's access to a mailbox, or null; "send" also needs send rights. */
export async function accessibleMailbox(
  c: Context<AppEnv>,
  mailboxId: string,
  permission: "read" | "send"
) {
  const preloaded = preloadedRows(
    c,
    (target) => target.kind === "mailbox" && target.mailboxId === mailboxId,
    accessRowSchema
  );

  const access = preloaded
    ? withKind(preloaded[0])
    : await timed(c, "d1", "access", () =>
        getMailboxAccess(createDb(c.env.DB), c.get("user").id, mailboxId)
      );

  if (!access || (permission === "send" && !access.canSend)) return null;

  return access;
}

/** The signed-in person's mailboxes, from the session batch when it carried them. */
export async function accessibleMailboxes(c: Context<AppEnv>) {
  const preloaded = preloadedRows(
    c,
    (target) => target.kind === "list",
    mailboxListRowSchema
  );

  return (
    preloaded ??
    (await timed(c, "d1", "mailboxes", () =>
      listAccessibleMailboxes(createDb(c.env.DB), c.get("user").id)
    ))
  );
}
