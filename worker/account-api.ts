import { Hono } from "hono";
import { adminRoutes } from "./admin/routes";
import type { AppEnv } from "./env";
import { ruleRoutes } from "./mail/rule-routes";
import { mailRoutes } from "./mail/routes";

/** Shared HTTP surface used by both the browser API and the MCP adapter. */
export const accountApi = new Hono<AppEnv>()
  .route("/mail/mailboxes/:id", ruleRoutes)
  .route("/mail", mailRoutes)
  .route("/admin", adminRoutes);
