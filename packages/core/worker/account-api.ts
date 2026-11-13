import { Hono } from "hono";

import { adminRoutes } from "./admin/routes";
import type { AppEnv } from "./env";
import { workspaceModules } from "./modules";

/** Routes core itself serves under /api for the signed-in person. */
export const coreAccountApi = new Hono<AppEnv>().route("/admin", adminRoutes);

let composed: Hono<AppEnv> | undefined;

/**
 * Shared HTTP surface used by both the browser API and the MCP adapter:
 * core's routes plus every module's, all under /api.
 */
export function accountApi() {
  if (!composed) {
    const app = new Hono<AppEnv>().route("/", coreAccountApi);

    for (const module of workspaceModules()) {
      if (module.accountApi) app.route("/", module.accountApi);
    }

    composed = app;
  }

  return composed;
}

/** Forget the composed routes; createWorkspace calls it after installing modules. */
export function resetAccountApi() {
  composed = undefined;
}
