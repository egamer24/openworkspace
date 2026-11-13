import {
  oauthScope,
  zValidator,
  apiError,
  createId,
  overRateLimit,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { Hono } from "hono";
import type { Context } from "hono";

import { normalizeBlockPattern } from "../../shared/mail-feedback";
import {
  MAIL_ORGANIZE_SCOPE,
  MAIL_READ_SCOPE,
  MAIL_SEND_SCOPE,
} from "../../shared/permissions";
import { mailboxStub } from "../mailbox";
import type { Email } from "../mailbox/schema";
import { accessibleMailbox } from "./access";
import { oneClickFetcher } from "./demo-routes";
import { emailListKey } from "./message-view";
import { submitOutgoing } from "./outbound-service";
import {
  blockPatternQuerySchema,
  blockSenderSchema,
  bulkReportSchema,
  mailboxQuerySchema,
  trustSenderSchema,
  unsubscribeSchema,
} from "./schemas";
import {
  oneClickHost,
  parseMailtoUnsubscribe,
  postOneClick,
} from "./unsubscribe";
import {
  recordWorkspaceFeedback,
  workspaceBlockPatterns,
} from "./workspace-safety";

function forbidden(c: Context<AppEnv>) {
  return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
}

/** Report one message as spam: Spam folder, sender feedback here and workspace-wide. */
async function reportOne(input: {
  env: Env;
  mailboxId: string;
  userId: string;
  email: Email;
}) {
  const result = await mailboxStub(input.env, input.mailboxId).reportMessage({
    emailId: input.email.id,
    userId: input.userId,
  });

  if (!result) return null;
  const sender = result.email.fromJson[0]?.address;

  if (sender) {
    await recordWorkspaceFeedback(input.env.DB, {
      mailboxId: input.mailboxId,
      emailId: result.email.id,
      address: sender,
      label: "spam",
    }).catch((error) =>
      console.error(`Could not share the report for ${result.email.id}`, error)
    );
  }

  return { moved: result.moved };
}

export const mailSafetyRoutes = new Hono<AppEnv>()
  .post(
    "/messages/:id/unsubscribe",
    oauthScope(MAIL_SEND_SCOPE),
    zValidator("query", mailboxQuerySchema),
    zValidator("json", unsubscribeSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");
      const access = await accessibleMailbox(c, mailboxId, "read");

      if (!access) return forbidden(c);
      const mailbox = mailboxStub(c.env, mailboxId);
      const stored = await mailbox.getEmail(c.req.param("id"));

      if (!stored || stored.direction !== "incoming") {
        return apiError(c, 404, "NOT_FOUND", "Message not found");
      }

      // Stored at ingestion from the original; never taken from the client.
      const email = stored;
      const methods = email.listUnsubscribeJson;
      const listKey = emailListKey(email);

      if (!methods || !listKey || (!methods.httpsUrl && !methods.mailto)) {
        return apiError(
          c,
          409,
          "CONFLICT",
          "This message has no unsubscribe option"
        );
      }

      const limitExceeded = await overRateLimit(
        c,
        "RATE_LIMIT_20",
        "mail-unsubscribe",
        user.id
      );

      if (limitExceeded) {
        return apiError(
          c,
          429,
          "RATE_LIMITED",
          "Too many unsubscribe requests"
        );
      }

      const record = (
        method: "one_click" | "mailto" | "link",
        status: "done" | "requested" | "opened" | "failed",
        target: string | null,
        detail: string | null
      ) =>
        mailbox.recordUnsubscription({
          listKey,
          emailId: email.id,
          method,
          status,
          target,
          detail,
          userId: user.id,
        });

      if (c.req.valid("json").method === "link") {
        if (!methods.httpsUrl) {
          return apiError(
            c,
            409,
            "CONFLICT",
            "This message has no unsubscribe page"
          );
        }

        const unsubscription = await record(
          "link",
          "opened",
          oneClickHost(methods.httpsUrl),
          null
        );

        return c.json({
          ok: true as const,
          outcome: "opened" as const,
          unsubscription,
          url: methods.httpsUrl,
          detail: null,
        });
      }

      let detail: string | null = null;

      if (methods.oneClick && methods.httpsUrl) {
        const result = await postOneClick(
          methods.httpsUrl,
          oneClickFetcher(c.env)
        );

        if (result.ok) {
          const unsubscription = await record(
            "one_click",
            "done",
            oneClickHost(methods.httpsUrl),
            result.redirected
              ? `Answered ${result.status} instead of 2xx`
              : null
          );

          return c.json({
            ok: true as const,
            outcome: "done" as const,
            unsubscription,
            url: null,
            detail: null,
          });
        }

        detail = result.detail;
      }

      const mailto = methods.mailto
        ? parseMailtoUnsubscribe(methods.mailto)
        : null;

      if (mailto && access.canSend) {
        const submission = await submitOutgoing({
          env: c.env,
          requestUrl: c.req.url,
          compose: {
            requestId: crypto.randomUUID(),
            mailboxId,
            userId: user.id,
            to: [mailto.to],
            cc: [],
            bcc: [],
            subject: mailto.subject,
            bodyText: mailto.body,
            attachments: [],
          },
          conversationId: createId("conv"),
          related: null,
          forwarded: null,
          includeRelatedContext: false,
          fromAddress: access.address,
          fromName: access.displayName,
          defer: (task) => c.executionCtx.waitUntil(task),
        });

        const failed = submission.email.transportState === "failed";

        const unsubscription = await record(
          "mailto",
          failed ? "failed" : "requested",
          mailto.to,
          failed ? submission.email.transportError : detail
        );

        if (!failed) {
          return c.json({
            ok: true as const,
            outcome: "requested" as const,
            unsubscription,
            url: null,
            detail,
          });
        }

        detail =
          submission.email.transportError ??
          "The unsubscribe email could not be sent";
      }

      if (methods.httpsUrl) {
        // Opening the page is left to the person, in a new tab, after this answer.
        return c.json({
          ok: true as const,
          outcome: "link" as const,
          unsubscription: null,
          url: methods.httpsUrl,
          detail,
        });
      }

      if (mailto && !access.canSend) {
        return apiError(
          c,
          403,
          "FORBIDDEN",
          "Unsubscribing by email requires send access to this mailbox"
        );
      }

      const unsubscription = await record(
        methods.oneClick ? "one_click" : "mailto",
        "failed",
        null,
        detail
      );

      return c.json({
        ok: true as const,
        outcome: "failed" as const,
        unsubscription,
        url: null,
        detail,
      });
    }
  )
  .post(
    "/messages/:id/report",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) return forbidden(c);

      const email = await mailboxStub(c.env, mailboxId).getEmail(
        c.req.param("id")
      );

      if (!email || email.direction !== "incoming") {
        return apiError(c, 404, "NOT_FOUND", "Message not found");
      }

      const result = await reportOne({
        env: c.env,
        mailboxId,
        userId: user.id,
        email,
      });

      if (!result) return apiError(c, 404, "NOT_FOUND", "Message not found");

      return c.json({ ok: true as const, ...result });
    }
  )
  .post(
    "/conversations/report",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("query", mailboxQuerySchema),
    zValidator("json", bulkReportSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");
      const access = await accessibleMailbox(c, mailboxId, "read");

      if (!access) return forbidden(c);
      const input = c.req.valid("json");

      const messages = await mailboxStub(c.env, mailboxId).latestIncomingEmails(
        input.conversationIds
      );

      // Each report concerns its own message; the mailbox serializes them.
      const results = await Promise.all(
        messages.map((email) =>
          reportOne({ env: c.env, mailboxId, userId: user.id, email })
        )
      );

      const reported = results.filter(Boolean).length;

      return c.json({ ok: true as const, reportedCount: reported });
    }
  )
  .post(
    "/messages/:id/not-spam",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) return forbidden(c);
      const emailId = c.req.param("id");

      const result = await mailboxStub(c.env, mailboxId).markNotSpam({
        emailId,
        userId: user.id,
      });

      if (!result) return apiError(c, 404, "NOT_FOUND", "Message not found");

      if (result.address) {
        await recordWorkspaceFeedback(c.env.DB, {
          mailboxId,
          emailId,
          address: result.address,
          label: "not_spam",
        }).catch((error) =>
          console.error(
            `Could not share the not-spam verdict for ${emailId}`,
            error
          )
        );
      }

      return c.json({
        ok: true as const,
        restored: result.restored,
        conversationId: result.conversationId,
        rejoined: result.rejoined,
        folder: result.folder,
      });
    }
  )
  .get(
    "/mailboxes/:id/blocked-senders",
    oauthScope(MAIL_READ_SCOPE),
    async (c) => {
      const mailboxId = c.req.param("id");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) return forbidden(c);

      const [blocked, workspace] = await Promise.all([
        mailboxStub(c.env, mailboxId).listBlockedSenders(),
        workspaceBlockPatterns(c.env.DB),
      ]);

      return c.json({
        ok: true as const,
        blocked,
        workspace: [...workspace].map(([pattern, at]) => ({
          pattern,
          blockedAt: at,
        })),
      });
    }
  )
  .post(
    "/mailboxes/:id/blocked-senders",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("json", blockSenderSchema),
    async (c) => {
      const mailboxId = c.req.param("id");
      const access = await accessibleMailbox(c, mailboxId, "read");

      if (!access) return forbidden(c);
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

      const own = access.address.toLocaleLowerCase();

      if (pattern === own || own.endsWith(pattern)) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "This mailbox cannot block its own address or domain"
        );
      }

      const result = await mailboxStub(c.env, mailboxId).blockSender(
        pattern,
        input.moveExisting
      );

      return c.json({ ok: true as const, ...result });
    }
  )
  .delete(
    "/mailboxes/:id/blocked-senders",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("query", blockPatternQuerySchema),
    async (c) => {
      const mailboxId = c.req.param("id");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) return forbidden(c);
      const pattern = normalizeBlockPattern(c.req.valid("query").pattern);

      if (
        !pattern ||
        !(await mailboxStub(c.env, mailboxId).unblockSender(pattern))
      ) {
        return apiError(c, 404, "NOT_FOUND", "Blocked sender not found");
      }

      return c.json({ ok: true as const });
    }
  )
  .put(
    "/mailboxes/:id/trusted-senders",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("json", trustSenderSchema),
    async (c) => {
      const mailboxId = c.req.param("id");

      if (!(await accessibleMailbox(c, mailboxId, "read"))) return forbidden(c);
      const input = c.req.valid("json");
      await mailboxStub(c.env, mailboxId).setSenderTrusted(
        input.address,
        input.trusted
      );

      return c.json({ ok: true as const });
    }
  );
