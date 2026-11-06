import { Hono } from "hono";
import { adminRoutes } from "./admin/routes";
import type { AppEnv } from "./env";
import { draftRoutes } from "./mail/drafts";
import { autoReplyRoutes } from "./mail/auto-reply-routes";
import { retentionRoutes } from "./mail/retention-routes";
import { ruleRoutes } from "./mail/rule-routes";
import { mailRoutes } from "./mail/routes";
import { spamRoutes } from "./mail/spam-routes";

/** Shared HTTP surface used by both the browser API and the MCP adapter. */
export const accountApi = new Hono<AppEnv>()
  .route("/mail/drafts", draftRoutes)
  .route("/mail/mailboxes/:id/auto-reply", autoReplyRoutes)
  .route("/mail/mailboxes/:id", retentionRoutes)
  .route("/mail/mailboxes/:id", ruleRoutes)
  .route("/mail/mailboxes/:id", spamRoutes)
  .route("/mail", mailRoutes)
  .route("/admin", adminRoutes);
