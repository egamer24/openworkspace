import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { CORE_PATHS } from "../shared/paths";
import { coreQueueRoles } from "../shared/queues";
import type { CoreQueueRole } from "../shared/queues";
import { coreAccountApi, accountApi, resetAccountApi } from "./account-api";
import { avatarRoutes } from "./auth/avatar";
import { verifySameOrigin } from "./auth/middleware";
import { mockAuthRoutes } from "./auth/mock";
import { authRoutes } from "./auth/routes";
import { runBackupTick } from "./backups/job";
import { bootstrapRoutes } from "./bootstrap";
import { configureWorkspace } from "./config";
import { reportUnlistedMailboxDomains } from "./config/mail-domains";
import type { WorkspaceConfigInput } from "./config/schema";
import type { AppEnv } from "./env";
import { consumeIdentitySync, scheduledIdentitySync } from "./identity-sync";
import {
  requestD1Session,
  withBookmark,
  withD1Session,
} from "./lib/d1-session";
import { serverTiming } from "./lib/server-timing";
import { mcpRoutes } from "./mcp/routes";
import { installModules, workspaceModules } from "./modules";
import type { QueueConsumer, WorkspaceModule } from "./modules";
import {
  oidcConsentRoutes,
  oidcLoginRoutes,
  oidcLogoutRoutes,
  oidcRoutes,
  wellKnownRoutes,
} from "./oidc/routes";
import { samlLoginRoutes, samlRoutes } from "./saml/routes";
import { syncDeclaredSsoApps } from "./sso/declared-apps";
import { syncDeclaredWebhooks } from "./webhooks/declared";
import { consumeWebhooks } from "./webhooks/delivery";
import { logoRoutes, webManifest } from "./workspace-branding";

export type WorkspaceOptions = WorkspaceConfigInput & {
  /** Modules such as `email()`, in the order their routes are tried. */
  modules?: WorkspaceModule[];
};

function notFound(c: Context<AppEnv>) {
  return c.json(
    { ok: false as const, error: { code: "NOT_FOUND", message: "Not found" } },
    404
  );
}

/** Core's routes; the browser's typed client is built from these. */
export const coreApp = new Hono<AppEnv>()
  .use("/api/*", verifySameOrigin)
  .use("/api/*", async (c, next) => {
    c.executionCtx.waitUntil(reportUnlistedMailboxDomains(c.env.DB));
    await next();
  })
  .get("/api/health", (c) => c.json({ ok: true as const }))
  .get("/api/modules", (c) =>
    c.json({
      ok: true as const,
      modules: workspaceModules().map((module) => module.name),
    })
  )
  .route("/api/bootstrap", bootstrapRoutes)
  .route("/api/workspace-logo", logoRoutes)
  .route("/api/avatars", avatarRoutes)
  .get(CORE_PATHS.webManifest, webManifest)
  .route("/api/auth", authRoutes)
  .route("/api/auth/mock", mockAuthRoutes)
  .route("/api/oidc/consent", oidcConsentRoutes)
  .route("/api/oidc/login", oidcLoginRoutes)
  .route("/api/oidc/logout", oidcLogoutRoutes)
  .route("/api/saml/login", samlLoginRoutes)
  .route("/api", coreAccountApi)
  .route(CORE_PATHS.mcp, mcpRoutes)
  .route(CORE_PATHS.wellKnown, wellKnownRoutes)
  .route(CORE_PATHS.oauth, oidcRoutes)
  .route(CORE_PATHS.saml, samlRoutes);

export type AppType = typeof coreApp;

/** Core's queue consumers by role; `QUEUE_NAMES` maps each role to its queue. */
const coreQueues = new Map<string, QueueConsumer>([
  [coreQueueRoles.webhooks, (batch, env) => consumeWebhooks(batch, env)],
  [
    coreQueueRoles.identitySync,
    (batch, env) => consumeIdentitySync(batch, env),
  ],
] satisfies [CoreQueueRole, QueueConsumer][]);

/** `QUEUE_NAMES`: each queue role's deployed queue name. */
const queueNamesSchema = z.record(z.string(), z.string());

/** The role of the queue a batch came from, by its deployed name. */
function queueRole(env: Env, queue: string) {
  const names = queueNamesSchema.parse(JSON.parse(env.QUEUE_NAMES));

  return Object.keys(names).find((role) => names[role] === queue);
}

/**
 * The Worker for a workspace. Deployments don't call it themselves: the
 * Worker entry `OpenWorkspace` generates (alchemy/entry.ts) calls it once
 * with the workspace's settings from alchemy.run.ts and each module's
 * server factory, and exports the result as default:
 *
 * ```ts
 * export default createWorkspace({ mailDomains: ["example.com"], modules: [email()] });
 * ```
 */
export function createWorkspace(options: WorkspaceOptions) {
  const { modules = [], ...config } = options;
  configureWorkspace(config);
  installModules(modules);
  resetAccountApi();

  const app = new Hono<AppEnv>();
  app.use("/api/*", serverTiming);

  // Apps declared in alchemy.run.ts are in D1 before anyone signs in to them.
  for (const path of [
    "/oauth/*",
    "/saml/*",
    "/api/admin/*",
    "/api/auth/*",
    "/.well-known/*",
  ]) {
    app.use(path, async (c, next) => {
      await syncDeclaredSsoApps(c.env);

      if (path === "/api/admin/*") await syncDeclaredWebhooks(c.env);
      await next();
    });
  }

  app.route("/", coreApp);

  for (const module of modules) {
    if (module.accountApi) app.route("/api", module.accountApi);

    if (module.routes) app.route("/", module.routes);
  }

  app.notFound(notFound).onError((error, c) => {
    console.error(error);

    return c.json(
      {
        ok: false as const,
        error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
      },
      500
    );
  });
  // The MCP adapter calls the same routes in-process.
  accountApi();

  const mailHandler = modules.find((module) => module.email);

  return {
    async fetch(request, env, ctx) {
      const session = requestD1Session(env.DB, request);

      return withBookmark(
        await app.fetch(request, withD1Session(env, session), ctx),
        session
      );
    },
    async email(message, env, ctx) {
      ctx.waitUntil(reportUnlistedMailboxDomains(env.DB));

      if (!mailHandler?.email) {
        message.setReject("This workspace does not receive mail");

        return;
      }

      await mailHandler.email(message, env, ctx);
    },
    scheduled(controller, env, ctx) {
      ctx.waitUntil(scheduledIdentitySync(env));
      ctx.waitUntil(syncDeclaredSsoApps(env));
      ctx.waitUntil(syncDeclaredWebhooks(env));
      // Starts the day's backup, or continues one; nothing without `backups`.
      ctx.waitUntil(runBackupTick(env, new Date(controller.scheduledTime)));

      for (const module of modules) {
        if (module.scheduled) {
          ctx.waitUntil(module.scheduled(controller, env, ctx));
        }
      }
    },
    queue(batch, env, ctx) {
      const role = queueRole(env, batch.queue);

      const consume =
        role === undefined
          ? undefined
          : (coreQueues.get(role) ??
            modules.find((module) => module.queues?.[role])?.queues?.[role]);

      if (!consume) throw new Error(`No handler for queue ${batch.queue}`);

      return consume(batch, env, ctx);
    },
  } satisfies ExportedHandler<Env>;
}
