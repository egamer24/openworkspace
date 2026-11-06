import { Hono } from "hono";
import { adminRoutes } from "./admin/routes";
import { driveRoutes } from "./drive/routes";
import type { AppEnv } from "./env";
import { mailRoutes } from "./mail/routes";

/** Shared HTTP surface used by both the browser API and the MCP adapter. */
export const accountApi = new Hono<AppEnv>()
  .route("/mail", mailRoutes)
  .route("/admin", adminRoutes)
  .route("/drive", driveRoutes);
