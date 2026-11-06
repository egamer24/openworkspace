import { Hono } from "hono";
import { adminRoutes } from "./admin/routes";
import type { AppEnv } from "./env";
import { mailRoutes } from "./mail/routes";
import { throwawayRoutes } from "./mail/throwaway-addresses";

/** Shared HTTP surface used by both the browser API and the MCP adapter. */
export const accountApi = new Hono<AppEnv>()
  .route("/mail/throwaway-addresses", throwawayRoutes)
  .route("/mail", mailRoutes)
  .route("/admin", adminRoutes);
