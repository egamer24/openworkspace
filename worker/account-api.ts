import { Hono } from "hono";
import { adminRoutes } from "./admin/routes";
import type { AppEnv } from "./env";
import { draftRoutes } from "./mail/drafts";
import { mailRoutes } from "./mail/routes";

/** Shared HTTP surface used by both the browser API and the MCP adapter. */
export const accountApi = new Hono<AppEnv>()
  .route("/mail/drafts", draftRoutes)
  .route("/mail", mailRoutes)
  .route("/admin", adminRoutes);
