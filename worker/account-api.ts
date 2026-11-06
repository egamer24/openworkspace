import { Hono } from "hono";
import { adminRoutes } from "./admin/routes";
import type { AppEnv } from "./env";
import { mailRoutes } from "./mail/routes";
import { spamRoutes } from "./mail/spam-routes";

/** Shared HTTP surface used by both the browser API and the MCP adapter. */
export const accountApi = new Hono<AppEnv>()
  .route("/mail/mailboxes/:id", spamRoutes)
  .route("/mail", mailRoutes)
  .route("/admin", adminRoutes);
