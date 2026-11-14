import type { McpServer } from "@modelcontextprotocol/server";
import type { Context, Hono } from "hono";

import { workspaceScopePattern } from "../shared/oidc";
import {
  coreWebhookEvents,
  mergeWebhookEvents,
  webhookEventPattern,
} from "../shared/webhooks";
import type { WebhookEventDeclaration } from "../shared/webhooks";
import { corePermissions } from "../shared/workspace";
import type { PermissionDefinition } from "../shared/workspace";
import type { SessionCompanion } from "./auth/session";
import type { Database } from "./db/client";
import type { ModuleWebhookSource } from "./db/json";
import type { AppEnv } from "./env";
import type { BatchStatement } from "./lib/batch";
import type { AccountApiClient } from "./mcp/account-client";
import { coreScopeIds } from "./oidc/scopes";

/**
 * A workspace module such as mail: its HTTP routes, Cloudflare event
 * handlers, MCP tools, and the hooks core calls when people or addresses
 * change. A module's `WorkspaceModuleInfra.server` names the factory that
 * returns it; the generated Worker entry passes it to `createWorkspace`.
 */
export type WorkspaceModule = {
  /** Stable id, also shown to the browser app, e.g. "email". */
  name: string;
  /**
   * Routes under /api that act for the signed-in person. The MCP server
   * reaches them in-process, so they are also its tools' backend.
   */
  accountApi?: Hono<AppEnv>;
  /**
   * Parts of the workspace this module lets an administrator hand to a
   * member, listed with core's in the people editor. Ids are unique across
   * the workspace. Routes the module serves under /api/admin/<section> are
   * left to the module to authorize, e.g. with `requirePermission(id)`.
   */
  permissions?: PermissionDefinition[];
  /**
   * OAuth scopes the module's routes and MCP tools require besides its
   * permissions' (e.g. "mail.read"), with what the consent screen says.
   * Anyone may grant them; the routes still check what the person can open.
   */
  oauthScopes?: ModuleOauthScopes;
  /**
   * Webhook events the module sends, with what the webhook editor says;
   * the same declaration as its `ClientModule.webhookEvents`.
   */
  webhookEvents?: Record<string, WebhookEventDeclaration>;
  /**
   * The module's part of GET /api/bootstrap, the browser app's first request:
   * what it shows first for the URL the app opens at, so the browser does not
   * ask for it separately (the client module's `seed` puts it in its query
   * cache). `companion` runs in the session lookup's D1 batch, scoped to the
   * session like `requireAuthWith`'s; `load` runs only for a valid session,
   * signed in as it, in parallel with the other modules', and gets the
   * companion's result. A failed `load` leaves the module out.
   */
  bootstrap?: {
    companion?: SessionCompanion;
    /** Resolves to what the client module's `seed` reads, sent as JSON. */
    load: (
      c: Context<AppEnv>,
      input: { pathname: string; search: URLSearchParams; companion: unknown }
    ) => Promise<object>;
  };
  /** Other routes, mounted at the Worker root (e.g. /api/downloads). */
  routes?: Hono<AppEnv>;
  /** Incoming mail for an address in the workspace; at most one module handles it. */
  email?: (
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext
  ) => Promise<void>;
  /**
   * Queue consumers by role, e.g. "office-previews": the `role` of the
   * module's `WorkspaceQueueConsumer`, which `QUEUE_NAMES` maps to the
   * queue's deployed name.
   */
  queues?: Record<string, QueueConsumer>;
  scheduled?: (
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ) => Promise<void>;
  /**
   * Loads the module's MCP tool registration. A loader, so the MCP SDK and
   * the tools load only with the first MCP request.
   */
  mcpTools?: () => Promise<McpToolRegistrar>;
  /**
   * Builds the payload of a webhook event from a source of this kind that
   * the module queued (`{ kind, mailboxId?, ... }`), sent as the event's
   * JSON `data`; core's own kind is "data".
   */
  webhookSources?: Record<
    string,
    (env: Env, source: ModuleWebhookSource) => Promise<object>
  >;
  hooks?: {
    /**
     * An address was created or changed, e.g. a forward's destinations. Runs
     * after the change is stored; a failure is logged, not undone.
     */
    mailboxSaved?: (env: Env, mailboxId: string) => Promise<void>;
    /**
     * An address was deleted; remove what the module stored for it. Deleting
     * a mailbox deletes its aliases first, and this runs for each of them.
     */
    mailboxDeleted?: (env: Env, mailboxId: string) => Promise<void>;
    /**
     * Someone may have lost access to a mailbox: a person was disabled or
     * taken off a team, a team's members or send rights changed, or a team
     * address moved to another team. Runs after the change is stored; a
     * failure is logged, not undone. Check what the module keeps per person
     * against `mailboxAccess` (`canSend`) and `users.status`: a disabled
     * person keeps their rows there. `defer` is the request's `waitUntil`,
     * for `deleteMailboxAddress`.
     */
    mailboxAccessChanged?: (
      env: Env,
      defer: (task: Promise<unknown>) => void
    ) => Promise<void>;
    /**
     * One browser session ended on purpose: the person or an administrator
     * revoked it, or it signed out. Returns the statements that drop what
     * the module keeps for the device on that session; they run in the D1
     * batch that deletes the session, so both land or neither does.
     * Expiry and core's pruning of old sessions do not call it.
     */
    sessionRevoked?: (
      db: Database,
      session: { userId: string; sessionId: string }
    ) => BatchStatement[];
    /**
     * Every session of a person was revoked: they were disabled, or
     * recovered their account. Returns the statements that drop what the
     * module keeps per device, run in the revocations' D1 batch.
     */
    sessionsRevoked?: (db: Database, userId: string) => BatchStatement[];
    /** Local demo data, created when the seeded demo workspace opens. */
    seedDemo?: (
      env: Env,
      input: { db: Database; userId: string }
    ) => Promise<void>;
  };
};

/**
 * A module's OAuth scopes: listed under `title` on the consent screen and in
 * settings, as group `group`. A scope `byDefault` is what a self-registered
 * app (an MCP client) gets when it asks for nothing, with offline_access.
 */
export type ModuleOauthScopes = {
  group: string;
  title: string;
  scopes: { id: string; label: string; byDefault?: boolean }[];
};

/** Consumes one batch of a queue. */
export type QueueConsumer = (
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext
) => Promise<void>;

/**
 * Registers an MCP tool if the request's token has `scope` (every one of
 * them for a list, one of them for `{ anyOf }`); see mcp/scoped-tools.ts. Tools are only ever
 * registered through it, so each declares the scope it needs.
 */
export type ScopedToolRegistrar = (
  scope: string | readonly string[] | { anyOf: readonly string[] }
) => McpServer["registerTool"];

/** Adds a module's tools to the MCP server of one request. */
export type McpToolRegistrar = (
  tool: ScopedToolRegistrar,
  input: { api: AccountApiClient; scopes: readonly string[] }
) => void;

let installed: readonly WorkspaceModule[] = [];

let permissions: readonly PermissionDefinition[] = corePermissions;
let adminSections: ReadonlySet<string> = new Set();

let webhookEvents: Readonly<Record<string, WebhookEventDeclaration>> =
  coreWebhookEvents;

export function installModules(modules: readonly WorkspaceModule[]) {
  const names = new Set<string>();

  const permissionIds = new Set<string>(
    corePermissions.map((permission) => permission.id)
  );

  const scopes = new Set<string>([
    ...corePermissions.map((permission) => permission.scope),
    ...coreScopeIds(),
  ]);

  const addScope = (scope: string, module: string) => {
    if (!workspaceScopePattern.test(scope) || scopes.has(scope)) {
      throw new Error(
        `Scope ${scope} of module ${module} is invalid or already defined`
      );
    }

    scopes.add(scope);
  };

  const events = new Set(Object.keys(coreWebhookEvents));
  const sourceKinds = new Set(["data"]);

  for (const module of modules) {
    if (names.has(module.name)) {
      throw new Error(`Module ${module.name} is listed twice`);
    }

    for (const event of Object.keys(module.webhookEvents ?? {})) {
      if (!webhookEventPattern.test(event) || events.has(event)) {
        throw new Error(
          `Webhook event ${event} of module ${module.name} is invalid or already defined`
        );
      }

      events.add(event);
    }

    for (const kind of Object.keys(module.webhookSources ?? {})) {
      if (sourceKinds.has(kind)) {
        throw new Error(
          `Webhook source ${kind} of module ${module.name} is already defined`
        );
      }

      sourceKinds.add(kind);
    }

    names.add(module.name);

    for (const permission of module.permissions ?? []) {
      if (permissionIds.has(permission.id)) {
        throw new Error(
          `Permission ${permission.id} of module ${module.name} is already defined`
        );
      }

      permissionIds.add(permission.id);
      addScope(permission.scope, module.name);
    }

    for (const scope of module.oauthScopes?.scopes ?? []) {
      addScope(scope.id, module.name);
    }
  }

  installed = modules;
  webhookEvents = mergeWebhookEvents(modules);
  permissions = [
    ...corePermissions,
    ...modules.flatMap((module) => module.permissions ?? []),
  ];
  adminSections = new Set(
    modules.flatMap((module) =>
      (module.accountApi?.routes ?? []).flatMap((route) => {
        const [, prefix, section] = route.path.split("/");

        return prefix === "admin" &&
          section &&
          section !== "*" &&
          !section.startsWith(":")
          ? [section]
          : [];
      })
    )
  );
}

/** Every permission in this workspace: core's, then the installed modules'. */
export function workspacePermissions() {
  return permissions;
}

/**
 * First path segments under /api/admin that installed modules serve; the
 * modules authorize those requests themselves.
 */
export function moduleAdminSections() {
  return adminSections;
}

export function workspaceModules() {
  return installed;
}

/** Every webhook event this workspace sends: the modules', then core's. */
export function workspaceWebhookEvents() {
  return webhookEvents;
}

/** Whether `event` carries a mailbox's mail (`WebhookEventDeclaration.mailboxes`). */
export function isMailboxEvent(event: string) {
  return Boolean(webhookEvents[event]?.mailboxes);
}

type ModuleHooks = NonNullable<WorkspaceModule["hooks"]>;

/** Hooks that hand core D1 statements to run in its own batch. */
type StatementHook = {
  [K in keyof ModuleHooks]-?: ReturnType<
    NonNullable<ModuleHooks[K]>
  > extends BatchStatement[]
    ? K
    : never;
}[keyof ModuleHooks];

/** Runs every installed module's `hook`, in install order. */
export async function runModuleHooks<
  K extends Exclude<keyof ModuleHooks, StatementHook>,
>(hook: K, ...args: Parameters<NonNullable<ModuleHooks[K]>>) {
  for (const module of installed) {
    // SAFETY: `hooks[hook]` is the hook named K, whose parameters are `args`;
    // TypeScript cannot call a generic K's member without widening it.
    const run = module.hooks?.[hook] as
      | ((...input: typeof args) => Promise<void>)
      | undefined;

    // oxlint-disable-next-line eslint/no-await-in-loop -- hooks run in install order, and a failing one stops the rest as before
    if (run) await run(...args);
  }
}

/**
 * Every installed module's statements for `hook`, in install order, for
 * the caller to put in the same D1 batch as its own change.
 */
export function moduleHookStatements<K extends StatementHook>(
  hook: K,
  ...args: Parameters<NonNullable<ModuleHooks[K]>>
): BatchStatement[] {
  return installed.flatMap((module) => {
    // SAFETY: as in runModuleHooks; a statement hook returns its statements.
    const statements = module.hooks?.[hook] as
      | ((...input: typeof args) => BatchStatement[])
      | undefined;

    return statements ? statements(...args) : [];
  });
}
