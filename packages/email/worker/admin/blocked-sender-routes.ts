import {
  zValidator,
  oauthScope,
  createDb,
  configuredMailDomains,
  mailboxes,
  users,
  apiError,
  requireAuth,
  requirePermission,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import { normalizeBlockPattern } from "../../shared/mail-feedback";
import {
  BLOCK_SENDERS_SCOPE,
  MANAGE_BLOCKED_SENDERS,
} from "../../shared/permissions";
import { blockedSenders } from "../db/schema";
import { forgetWorkspaceBlockPatterns } from "../mail/workspace-safety";
import { mailboxStub } from "../mailbox";
import { workspaceBlockQuerySchema, workspaceBlockSchema } from "./schemas";

const MAILBOX_FANOUT = 20;

/** Moves existing mail from a newly blocked pattern to Spam in every mailbox. */
async function moveBlockedMailToSpam(env: Env, pattern: string) {
  // Only mailboxes keep mail; lists, aliases and forwards have none.
  const rows = await createDb(env.DB)
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.delivery, "inbox"));

  let conversations = 0;
  let affectedMailboxes = 0;
  let failedMailboxes = 0;

  for (let index = 0; index < rows.length; index += MAILBOX_FANOUT) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- at most MAILBOX_FANOUT mailboxes at a time, so one block does not wake every mailbox at once
    const results = await Promise.allSettled(
      rows
        .slice(index, index + MAILBOX_FANOUT)
        .map((row) => mailboxStub(env, row.id).moveSenderToSpam(pattern))
    );

    for (const result of results) {
      if (result.status === "rejected") {
        failedMailboxes += 1;
        console.error(
          `Could not move mail from ${pattern} to Spam`,
          result.reason
        );
      } else if (result.value > 0) {
        conversations += result.value;
        affectedMailboxes += 1;
      }
    }
  }

  return { conversations, mailboxes: affectedMailboxes, failedMailboxes };
}

/** Workspace-wide sender blocks, managed by members allowed to block senders. */
export const blockedSenderAdminRoutes = new Hono<AppEnv>()
  .use("*", requireAuth, requirePermission(MANAGE_BLOCKED_SENDERS))
  // An app's token needs this permission's scope (the path, not "*": these
  // routes sit under /admin next to core's).
  .use("/blocked-senders", oauthScope(BLOCK_SENDERS_SCOPE))
  .get("/blocked-senders", async (c) => {
    const rows = await createDb(c.env.DB)
      .select({
        pattern: blockedSenders.pattern,
        createdAt: blockedSenders.createdAt,
        createdByName: users.name,
      })
      .from(blockedSenders)
      .leftJoin(users, eq(users.id, blockedSenders.createdByUserId))
      .orderBy(desc(blockedSenders.createdAt));

    return c.json({
      ok: true as const,
      blockedSenders: rows.map((row) => ({
        pattern: row.pattern,
        scope: row.pattern.startsWith("@")
          ? ("domain" as const)
          : ("address" as const),
        createdByName: row.createdByName,
        createdAt: row.createdAt,
      })),
    });
  })
  .post(
    "/blocked-senders",
    zValidator("json", workspaceBlockSchema),
    async (c) => {
      const input = c.req.valid("json");
      const pattern = normalizeBlockPattern(input.pattern);

      if (!pattern) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "Enter an email address or a domain"
        );
      }

      const db = createDb(c.env.DB);
      const own = configuredMailDomains();
      const domain = pattern.slice(pattern.lastIndexOf("@") + 1);

      if (
        own.some(
          (name) =>
            domain === name ||
            domain.endsWith(`.${name}`) ||
            name.endsWith(`.${domain}`)
        )
      ) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "Workspace mail domains cannot be blocked"
        );
      }

      await db
        .insert(blockedSenders)
        .values({
          pattern,
          createdByUserId: c.get("user").id,
          createdAt: new Date(),
        })
        .onConflictDoNothing();
      forgetWorkspaceBlockPatterns();

      const moved = input.moveExisting
        ? await moveBlockedMailToSpam(c.env, pattern)
        : null;

      return c.json({ ok: true as const, pattern, moved });
    }
  )
  .delete(
    "/blocked-senders",
    zValidator("query", workspaceBlockQuerySchema),
    async (c) => {
      const pattern = normalizeBlockPattern(c.req.valid("query").pattern);

      const deleted = pattern
        ? await createDb(c.env.DB)
            .delete(blockedSenders)
            .where(eq(blockedSenders.pattern, pattern))
            .returning()
        : [];

      if (!deleted.length) {
        return apiError(c, 404, "NOT_FOUND", "Blocked sender not found");
      }

      forgetWorkspaceBlockPatterns();

      return c.json({ ok: true as const });
    }
  );
