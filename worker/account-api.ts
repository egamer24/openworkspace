import { Hono } from "hono";
import { adminRoutes } from "./admin/routes";
import type { AppEnv } from "./env";
import { retentionRoutes } from "./mail/retention-routes";
import { mailRoutes } from "./mail/routes";

/** Shared HTTP surface used by both the browser API and the MCP adapter. */
export const accountApi = new Hono<AppEnv>()
  .route("/mail/mailboxes/:id", retentionRoutes)
  .route("/mail", mailRoutes)
  .route("/admin", adminRoutes);
