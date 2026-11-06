import { Hono } from "hono";
import { adminRoutes } from "./admin/routes";
import type { AppEnv } from "./env";
import { autoReplyRoutes } from "./mail/auto-reply-routes";
import { mailRoutes } from "./mail/routes";

/** Shared HTTP surface used by both the browser API and the MCP adapter. */
export const accountApi = new Hono<AppEnv>()
  .route("/mail/mailboxes/:id/auto-reply", autoReplyRoutes)
  .route("/mail", mailRoutes)
  .route("/admin", adminRoutes);
