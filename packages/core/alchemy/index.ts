/* oxlint-disable oxc/no-barrel-file -- the package's public Alchemy entry point */
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import * as Cloudflare from "@alchemy.run/cloudflare";
import { AlchemyContext, dotAlchemyDirectory } from "alchemy/AlchemyContext";
import * as Output from "alchemy/Output";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { coreWorkerFirst, workerFirstPatterns } from "../shared/paths.ts";
import { coreQueueRoles } from "../shared/queues.ts";
import { workspaceConfigSchema } from "../worker/config/schema.ts";
import type {
  WorkspaceConfig,
  WorkspaceConfigInput,
} from "../worker/config/schema.ts";
import {
  RATE_LIMIT_PERIOD_SECONDS,
  rateLimitBindings,
} from "../worker/lib/rate-limit-bindings.ts";
import type { RateLimitBinding } from "../worker/lib/rate-limit-bindings.ts";
import { buildClient } from "./client.ts";
import type { WorkspaceModuleClient } from "./client.ts";
import { workerEntrySource, writeWorkerEntry } from "./entry.ts";
import type { WorkspaceServerEntry } from "./entry.ts";
import { keyProviders, OidcSigningKey, SigningCertificate } from "./keys.ts";
import { workspaceOrigin } from "./origin.ts";
import { ssoProviders, workspaceEndpoints } from "./sso.ts";
import { webhookProviders } from "./webhooks.ts";

export type { WorkspaceModuleClient } from "./client.ts";

export type { Json, WorkspaceServerEntry } from "./entry.ts";

export type { WorkspaceConfig } from "../worker/config/schema.ts";

export * from "./keys.ts";

export * from "./sso.ts";

export * from "./webhooks.ts";

/** The package root, one up from alchemy/. */
const packageDir = resolve(import.meta.dirname, "..");

/** A queue the workspace Worker consumes. */
export type WorkspaceQueueConsumer = {
  /** Logical id of the `Consumer` resource. */
  id: string;
  /**
   * What the queue is for, e.g. "office-previews": the key of the module's
   * consumer in its `queues`. The Worker gets each role's deployed queue
   * name (`QUEUE_NAMES`) and hands a batch to the consumer of its role.
   */
  role: string;
  queue: Effect.Effect<Cloudflare.Queues.Queue, never, Cloudflare.Providers>;
  settings: Cloudflare.Queues.ConsumerSettings;
};

/** A module's Worker bindings, or an Effect that declares their resources. */
export type ModuleEnv =
  | Cloudflare.WorkerBindingProps
  | Effect.Effect<Cloudflare.WorkerBindingProps, unknown, unknown>;

/** What a module adds to the workspace: its Worker code, browser app part, and Cloudflare resources. */
export type WorkspaceModuleInfra = {
  name: string;
  /**
   * The module's Worker code: `entry` exports a factory that returns its
   * `WorkspaceModule` (e.g. `email()`), and the classes its bindings name.
   * The generated Worker entry passes the factory's result to
   * `createWorkspace` and re-exports the classes.
   */
  server?: WorkspaceServerEntry;
  /**
   * Prefixes outside core's (/api, /mcp, /oauth, ...) the module's routes
   * serve, e.g. `["/jmap"]`: each, and everything under it, runs on the
   * Worker before static assets.
   */
  routes?: string[];
  /** Directory of the module's D1 migrations, applied after core's. */
  migrations?: string;
  /** The module's part of the browser app, built into it on every deploy. */
  client?: WorkspaceModuleClient;
  /**
   * Worker bindings: resources, values, or secrets; an Effect when they come
   * from resources. A function gets the origin the app is served on
   * (`https://<hostname>`; `http://<hostname>` under `alchemy dev`), e.g.
   * for a bucket's CORS.
   */
  env?: ModuleEnv | ((workspace: { origin: string }) => ModuleEnv);
  /** Names of optional secrets the module reads, bound when set. */
  secrets?: string[];
  /** Queues the Worker consumes. */
  consumers?: WorkspaceQueueConsumer[];
  /** Runs once the Worker exists: mail routing and so on. */
  afterWorker?: (input: {
    /** The deployed script's name, as Alchemy's resource output. */
    workerName: Cloudflare.Worker["workerName"];
    /**
     * The workspace's validated settings from `OpenWorkspace`'s props, as
     * the Worker reads them: `mailDomains` (normalized, primary first) and `ai`.
     */
    config: WorkspaceConfig;
  }) => Effect.Effect<unknown, unknown, unknown>;
};

/** An `OidcClient`, `SamlApp` or `Webhook`: what the Worker stores for it, as a secret. */
type DeclaredResource = {
  declaration: Output.Output<Redacted.Redacted<string>>;
};

export type OpenWorkspaceProps = {
  /**
   * Hostname the app is served on (its custom domain), in a zone of this
   * account, e.g. `"workspace.example.com"`. The app's origin is
   * `https://<hostname>`: the OIDC issuer, the SAML IdP, and the passkeys'
   * relying party. Under `alchemy dev` (local dev and test stacks) it is the
   * host the local Worker is reached on instead, e.g. `"localhost:5173"`,
   * served over http with no custom domain.
   */
  hostname: string;
  /**
   * Mail domains, primary first, at least one; the first is the primary
   * domain. The only list of them: every new address must be on one, and
   * addresses on a domain dropped from it keep working, but no new one is
   * created there (docs/configuration.md). Modules get them too (`afterWorker`'s `config`): `Email()`
   * sets up Email Routing and Email Sending for each.
   */
  mailDomains: [string, ...string[]];
  /**
   * AI providers and the features that use them. Secrets never go here:
   * a provider names the Worker secret that holds its key (`apiKeyEnv`).
   */
  ai?: WorkspaceConfigInput["ai"];
  /**
   * Daily snapshots of the workspace to an R2 bucket of its own, which the
   * deploy creates: `{}` keeps the newest of the last 14 days and of the
   * last 8 weeks (`keepDays`, `keepWeeks`). Off without it
   * (docs/configuration.md#backups).
   */
  backups?: WorkspaceConfigInput["backups"];
  /** Module infrastructure, e.g. `Email()`. */
  modules?: WorkspaceModuleInfra[];
  /**
   * Single sign-on apps (`OidcClient` / `SamlApp` resources), their SCIM
   * provisioning included; read-only in the admin UI.
   */
  apps?: DeclaredResource[];
  /** Webhook endpoints (`Webhook` resources); read-only in the admin UI. */
  webhooks?: DeclaredResource[];
  /** Extra Worker bindings or variables. */
  env?: Cloudflare.WorkerBindingProps;
  /**
   * Local development and tests only: turns on the demo sign-in, which
   * answers only on localhost or 127.0.0.1 (`ALLOW_MOCK_AUTH`).
   */
  mockAuth?: boolean;
  /** SQL files imported into D1 after migrations, e.g. demo data. */
  seed?: string[];
  /** Local dev server settings for `alchemy dev`. */
  dev?: { host?: string; port?: number };
  /**
   * For test Workers only: `server.entry` exports a function that takes the
   * workspace's handlers (and `server.options`) and returns the Worker's,
   * e.g. with test routes in front. Its `classes` take the place of the
   * modules' classes of the same name.
   */
  wrap?: { server: WorkspaceServerEntry };
};

/**
 * Where a deployment keeps what it generates (the Worker entry, migrations,
 * and the browser app): under Alchemy's runtime directory, next to its state
 * and local data, by stack and stage.
 */
const workDir = Effect.gen(function* () {
  const dotAlchemy = yield* dotAlchemyDirectory;
  const stack = yield* Stack;
  const stage = yield* Stage;

  return resolve(dotAlchemy, "openworkspace", stack.name, stage);
});

/**
 * Copies core's and each module's D1 migrations into one directory:
 * `core/<file>` and `modules/<module>/<file>`. Alchemy orders the files by
 * their relative paths, and those paths are the names recorded in
 * `__alchemy_migrations`, so core's always run first and a module's names
 * never depend on its place in `modules`. Modules depend only on core.
 */
function collectMigrations(dir: string, modules: WorkspaceModuleInfra[]) {
  const target = join(dir, "migrations");
  rmSync(target, { recursive: true, force: true });

  const sources = [
    { into: join(target, "core"), dir: join(packageDir, "migrations") },
    ...modules.flatMap((module) =>
      module.migrations
        ? [
            {
              into: join(target, "modules", module.name),
              dir: module.migrations,
            },
          ]
        : []
    ),
  ];

  for (const source of sources) {
    mkdirSync(source.into, { recursive: true });

    for (const file of readdirSync(source.dir)) {
      if (file.endsWith(".sql")) {
        cpSync(join(source.dir, file), join(source.into, file));
      }
    }
  }

  return target;
}

/** The values of `outputs`, in order, once all resolve. */
function allOutputs<Value>(outputs: Output.Output<Value>[]) {
  // SAFETY: Output.all resolves to the array of its arguments' values; its
  // type for a spread array (rather than a tuple) names one element's type.
  return Output.all(...outputs) as Output.Output<Value[]>;
}

/** Resources' secret declarations as one secret JSON array, for a binding. */
function secretList(items: DeclaredResource[]) {
  if (!items.length) return Redacted.make("[]");

  return Output.map(
    allOutputs(items.map((item) => item.declaration)),
    (list: Redacted.Redacted<string>[]) =>
      Redacted.make(`[${list.map((item) => Redacted.value(item)).join(",")}]`)
  );
}

/**
 * The secrets the workspace's AI providers read, each named by its
 * provider's `apiKeyEnv`, read from the environment (or `.env`) at deploy
 * time. One that is not set fails the deploy. Signing keys are not among
 * them: Alchemy mints those (see `keys.ts`).
 */
const readAiSecrets = (config: WorkspaceConfig) =>
  Effect.gen(function* () {
    const bound: Record<string, Redacted.Redacted<string>> = {};

    for (const [name, provider] of Object.entries(config.ai.providers)) {
      if (provider.type === "cloudflare" || !provider.apiKeyEnv) continue;
      const value = yield* Config.option(Config.Redacted(provider.apiKeyEnv));

      if (Option.isNone(value) || !Redacted.value(value.value)) {
        return yield* Effect.die(
          new Error(
            `The ${name} AI provider reads its key from ${provider.apiKeyEnv} (ai.providers.${name}.apiKeyEnv); ` +
              `set ${provider.apiKeyEnv} in the environment or .env before deploying`
          )
        );
      }

      bound[provider.apiKeyEnv] = value.value;
    }

    return bound;
  });

/** Optional secrets modules read, bound when set in the environment (or `.env`). */
const readOptionalSecrets = (names: string[]) =>
  Effect.gen(function* () {
    const bound: Record<string, Redacted.Redacted<string>> = {};

    for (const name of names) {
      const value = yield* Config.option(Config.Redacted(name));

      if (Option.isSome(value)) bound[name] = value.value;
    }

    return bound;
  });

/**
 * Cloudflare's providers plus those for the workspace's signing keys; pass
 * as the stack's `providers`.
 */
export const providers = () =>
  Layer.mergeAll(
    Cloudflare.providers(),
    keyProviders(),
    ssoProviders(),
    webhookProviders()
  );

/** The Rate Limiting bindings, from their one declaration (worker/lib/rate-limit-bindings.ts). */
const rateLimit = (name: RateLimitBinding) => {
  const { limit, namespaceId } = rateLimitBindings[name];

  return Cloudflare.RateLimit(name, {
    namespaceId,
    simple: { limit, period: RATE_LIMIT_PERIOD_SECONDS },
  });
};

const rateLimitEnv = () =>
  ({
    RATE_LIMIT_10: rateLimit("RATE_LIMIT_10"),
    RATE_LIMIT_20: rateLimit("RATE_LIMIT_20"),
    RATE_LIMIT_30: rateLimit("RATE_LIMIT_30"),
    RATE_LIMIT_60: rateLimit("RATE_LIMIT_60"),
    RATE_LIMIT_120: rateLimit("RATE_LIMIT_120"),
  }) satisfies Record<RateLimitBinding, ReturnType<typeof rateLimit>>;

/** Whether this is `alchemy dev`: the dev, stack-test and e2e stacks, on the local runtime. */
const isDev = Effect.map(
  Effect.serviceOption(AlchemyContext),
  (alchemy) => Option.isSome(alchemy) && alchemy.value.dev
);

/**
 * The local runtime's endpoints (`/cdn-cgi/local/…`, e.g. a bucket's S3 API
 * for presigned URLs) sit behind its static assets router, which would
 * answer them with the browser app. Under `alchemy dev` they go to the
 * Worker's side, where the runtime serves them before the Worker.
 */
const localEndpointsFirst = Effect.map(isDev, (dev) =>
  dev ? workerFirstPatterns("/cdn-cgi/local") : []
);

/** Plain-text variables only some workspaces set. */
type OptionalVariables = {
  ALLOW_MOCK_AUTH?: string;
};

/** The backup bucket, bound only with `backups`. */
type BackupEnv = {
  BACKUP_STORAGE?: ReturnType<typeof Cloudflare.R2.Bucket>;
};

/** The runtime every workspace Worker targets. */
const workerCompatibility = { date: "2026-07-21", flags: ["nodejs_compat"] };

/**
 * Core's and the modules' Worker bindings and queue consumers: everything
 * the Worker is bound to apart from its code, browser app, and secrets read
 * from the environment.
 */
const workspaceBindings = (
  props: Pick<
    OpenWorkspaceProps,
    "hostname" | "apps" | "webhooks" | "seed" | "mockAuth" | "backups"
  >,
  origin: string,
  dir: string,
  modules: WorkspaceModuleInfra[]
) =>
  Effect.gen(function* () {
    const databaseProps: Cloudflare.D1.DatabaseProps = {
      // Reads in the Worker's per-request D1 sessions may use replicas near
      // the visitor (worker/lib/d1-session.ts); code without a session, and
      // every write, still reaches the primary.
      readReplication: { mode: "auto" },
      migrations: collectMigrations(dir, modules),
    };

    if (props.seed?.length) {
      databaseProps.importFiles = props.seed.map((file) => resolve(file));
    }

    const database = Cloudflare.D1.Database("Database", databaseProps);

    const webhooks = Cloudflare.Queues.Queue("Webhooks", {});
    const identitySync = Cloudflare.Queues.Queue("IdentitySync", {});

    const oidcKey = yield* OidcSigningKey("OidcSigningKey", {});

    const saml = yield* SigningCertificate("SamlSigningCertificate", {
      commonName: new URL(origin).hostname,
    });

    // Secret bindings: the declarations carry SCIM tokens and signing secrets.
    const ssoApps = secretList(props.apps ?? []);
    const declaredWebhooks = secretList(props.webhooks ?? []);

    const moduleEnv: Cloudflare.WorkerBindingProps = {};

    for (const module of modules) {
      const declared =
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- picks the function form of a module's typed `env` option; nothing here is unparsed input
        typeof module.env === "function" ? module.env({ origin }) : module.env;

      Object.assign(
        moduleEnv,
        Effect.isEffect(declared)
          ? // SAFETY: a module's env Effect declares resources, which need
            // only the Cloudflare providers this stack runs with, and fails
            // only as a deploy does.
            yield* declared as Effect.Effect<Cloudflare.WorkerBindingProps>
          : declared
      );
    }

    const settings = { batchSize: 10, maxRetries: 5, maxWaitTimeMs: 2000 };

    const consumers: WorkspaceQueueConsumer[] = [
      {
        id: "WebhooksConsumer",
        role: coreQueueRoles.webhooks,
        queue: webhooks,
        settings,
      },
      {
        id: "IdentitySyncConsumer",
        role: coreQueueRoles.identitySync,
        queue: identitySync,
        settings,
      },
      ...modules.flatMap((module) => module.consumers ?? []),
    ];

    const queueNames = new Map<string, Output.Output<string>>();

    for (const { role, queue } of consumers) {
      if (queueNames.has(role)) {
        return yield* Effect.die(new Error(`Two queues have the role ${role}`));
      }

      queueNames.set(role, (yield* queue).queueName);
    }

    const roles = [...queueNames.keys()];

    const queueNamesJson = Output.map(
      allOutputs([...queueNames.values()]),
      (names: string[]) =>
        JSON.stringify(
          Object.fromEntries(roles.map((role, index) => [role, names[index]]))
        )
    );

    const variables: OptionalVariables = {};

    // The demo sign-in, for localhost only (auth/mock.ts).
    if (props.mockAuth) variables.ALLOW_MOCK_AUTH = "true";
    // A bucket of its own, so a mistake in another can't take the backups with it.
    const backup: BackupEnv = {};

    if (props.backups) {
      backup.BACKUP_STORAGE = Cloudflare.R2.Bucket("Backups", {});
    }

    // The Worker's `Env` is derived from this object (`CoreEnv`), so each
    // binding is declared here only.
    const env = {
      DB: database,
      AI: Cloudflare.Workers.AI(),
      // Profile photos and the workspace logo as uploaded
      // (`avatars/<userId>/<id>`, `workspace/logo/<id>`); the Worker serves them.
      MEDIA: Cloudflare.R2.Bucket("Media", {}),
      ...backup,
      // Crops them to the sizes served, from the bytes read from MEDIA.
      IMAGES: Cloudflare.Images.Images("IMAGES"),
      WEBHOOKS: webhooks,
      IDENTITY_SYNC: identitySync,
      // Throttles, one binding per limit, shared by core and modules.
      ...rateLimitEnv(),
      /** The app's origin: what OIDC and SAML sign for, and the passkeys' relying party. */
      IDENTITY_PROVIDER_ORIGIN: origin,
      ...variables,
      OIDC_SIGNING_PRIVATE_JWK: oidcKey.privateJwk,
      SAML_SIGNING_PRIVATE_KEY: saml.privateKey,
      SAML_SIGNING_CERTIFICATE: saml.certificate,
      /** Single sign-on apps declared in alchemy.run.ts, as JSON (shared/sso-declarations.ts). */
      SSO_APPS: ssoApps,
      /** Webhook endpoints declared in alchemy.run.ts, with their secrets, as JSON. */
      DECLARED_WEBHOOKS: declaredWebhooks,
      /**
       * The deployed name of each queue the Worker consumes, by role (core's
       * and the modules'), as JSON. A batch is dispatched by the name it came from.
       */
      QUEUE_NAMES: queueNamesJson,
    };

    return { env, moduleEnv, consumers, samlCertificate: saml.certificate };
  });

/**
 * The workspace's configuration from these props: as written (for the
 * Worker entry, whose `createWorkspace` validates it again) and validated,
 * so a mistake fails the deploy.
 */
function workspaceConfig(props: OpenWorkspaceProps) {
  // The entry writes it as JSON, which leaves out an `ai` that is undefined.
  const input: WorkspaceConfigInput = {
    mailDomains: props.mailDomains,
    ai: props.ai,
    backups: props.backups,
  };

  const parsed = workspaceConfigSchema.safeParse(input);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`OpenWorkspace options are invalid:\n${issues}`);
  }

  return { input, config: parsed.data };
}

/**
 * The Worker entry for these props, written under Alchemy's directory: it
 * calls `createWorkspace` with the workspace's configuration and each
 * module's server factory.
 */
function workerEntry(
  dir: string,
  props: OpenWorkspaceProps,
  config: WorkspaceConfigInput,
  modules: WorkspaceModuleInfra[]
) {
  return writeWorkerEntry(
    dir,
    workerEntrySource({
      config,
      modules: modules.flatMap((module) =>
        module.server ? [{ name: module.name, server: module.server }] : []
      ),
      wrap: props.wrap?.server,
    })
  );
}

/**
 * A workspace on Cloudflare: D1, the Worker with the browser app (built
 * from core's UI and the modules' client parts on every deploy),
 * core's queues, the hourly cron, and whatever each module adds. The
 * Worker's entry is generated from these props, so alchemy.run.ts is the
 * deployment's only code.
 *
 * ```ts
 * // alchemy.run.ts
 * export default Alchemy.Stack("Workspace", { providers: providers(), state: Cloudflare.state() },
 *   OpenWorkspace({ hostname: "mail.acme.com", mailDomains: ["acme.com"], modules: [Email()] }));
 * ```
 *
 * Alchemy names every Cloudflare resource after the stack, the resource's
 * id, and the stage, with a random suffix (the Worker of stack `Workspace` on
 * stage `prod`: `workspace-workspace-prod-…`).
 */
export const OpenWorkspace = (props: OpenWorkspaceProps) =>
  deployWorkspace(props);

/**
 * What `OpenWorkspace` returns: where the workspace signs people in
 * (`WorkspaceEndpoints`), to hand to apps declared next to it, and the
 * Worker's URL and name.
 */
export type OpenWorkspaceOutputs = DeployedWorkspace;

type DeployedWorkspace = Effect.Success<ReturnType<typeof deployWorkspace>>;

/**
 * The Worker bindings core declares, as the Worker sees them: core's `Env`
 * (worker/bindings.d.ts) is this type. AI keys are read by name
 * (`apiKeyEnv`), and modules add their own.
 */
export type CoreEnv = Cloudflare.InferEnv<
  Effect.Success<ReturnType<typeof workspaceBindings>>["env"]
>;

const deployWorkspace = (props: OpenWorkspaceProps) =>
  Effect.gen(function* () {
    const modules = props.modules ?? [];
    const dir = yield* workDir;
    const { input, config } = yield* Effect.sync(() => workspaceConfig(props));

    const main = yield* Effect.sync(() =>
      workerEntry(dir, props, input, modules)
    );

    const clientDir = yield* Effect.promise(() =>
      buildClient({
        modules: modules.flatMap((module) =>
          module.client ? [module.client] : []
        ),
        outDir: join(dir, "client"),
      })
    );

    const dev = yield* isDev;

    const origin = yield* Effect.sync(() =>
      workspaceOrigin(props.hostname, dev, props.dev)
    );

    const { env, moduleEnv, consumers, samlCertificate } =
      yield* workspaceBindings(props, origin, dir, modules);

    const secrets = {
      ...(yield* readAiSecrets(config)),
      ...(yield* readOptionalSecrets(
        modules.flatMap((module) => module.secrets ?? [])
      )),
    };

    const workerProps: Cloudflare.WorkerProps<Cloudflare.WorkerBindingProps> = {
      main,
      compatibility: workerCompatibility,
      crons: ["17 * * * *"],
      assets: {
        directory: clientDir,
        notFoundHandling: "single-page-application",
        runWorkerFirst: [
          ...coreWorkerFirst,
          ...modules.flatMap((module) =>
            (module.routes ?? []).flatMap(workerFirstPatterns)
          ),
          ...(yield* localEndpointsFirst),
        ],
      },
      observability: { enabled: true },
      env: { ...env, ...moduleEnv, ...secrets, ...props.env },
    };

    // The custom domain; the local runtime has none and serves `dev` instead.
    if (!dev) workerProps.domain = new URL(origin).hostname;

    if (props.dev) workerProps.dev = { ...props.dev, strictPort: true };
    const worker = yield* Cloudflare.Worker("Workspace", workerProps);

    for (const { id, queue, settings } of consumers) {
      const { queueId } = yield* queue;
      yield* Cloudflare.Queues.Consumer(id, {
        queueId,
        scriptName: worker.workerName,
        settings,
      });
    }

    for (const module of modules) {
      if (module.afterWorker) {
        // SAFETY: a module's afterWorker declares resources, which need only
        // the Cloudflare providers this stack runs with, and fails only as a
        // deploy does.
        yield* module.afterWorker({
          workerName: worker.workerName,
          config,
        }) as Effect.Effect<unknown>;
      }
    }

    return {
      ...workspaceEndpoints(origin, samlCertificate),
      workerUrl: worker.url,
      workerName: worker.workerName,
    };
  });
