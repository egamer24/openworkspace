import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";

import { required } from "../shared/invariant.ts";
import { resetDeclaredSsoApps } from "../worker/sso/declared-apps.ts";
import { resetDeclaredWebhooks } from "../worker/webhooks/declared.ts";
import type { Decoded } from "./codec.ts";
import { decode, encode } from "./codec.ts";
import { routeOutboundFetch } from "./outbound.ts";
import type { D1Call, R2Call } from "./wire.ts";
import {
  d1Input,
  emailCall,
  envNames,
  fetchCall,
  hookCall,
  queueCall,
  r2Call,
  scheduledCall,
} from "./wire.ts";

/**
 * Test-only routes under /api/__test for a stack test Worker: a package's
 * test/stack/worker.ts default-exports `testWorker(...)`, and its test
 * stack hands that to `OpenWorkspace` as `wrap`, so the generated Worker
 * entry puts these routes in front of the workspace (never a deployment's
 * Worker). They let a stack suite
 * arrange and inspect what the public API does not expose: D1 and R2
 * directly, queue batches, inbound mail, the hourly cron, a request's
 * background work, and named hooks for the rest. Arguments and results use
 * codec.ts. `TEST_HOOKS`, bound by the test stack, is the URL of the test
 * process, which answers the Worker's outgoing requests (outbound.ts).
 */

const TEST_HOOKS_PATH = "/api/__test/";

type Handlers = Required<
  Pick<ExportedHandler<Env>, "fetch" | "email" | "scheduled" | "queue">
>;

export type HookContext = { env: Env; ctx: ExecutionContext };

/**
 * A named hook, run inside the Worker by `hooks.call(name, ...args)`. It
 * declares the parameters it takes (the arguments arrive decoded, as the
 * test sent them) and answers with any value the codec carries back.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- a hook answers with whatever its Worker code returns; the codec carries any value and the test names the type it expects (hooks.call<T>)
export type TestHook = (context: HookContext, ...args: never[]) => unknown;

/**
 * A route of its own under /api/__test/<name>: the decoded body and the
 * rest of the path. It answers with a Response, or with a value the codec
 * carries back.
 */
export type TestRoute = (
  context: HookContext & { input: Decoded; path: string[] }
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- like a hook, a route answers with any value the codec carries back (or a Response)
) => Promise<unknown>;

export type TestHookOptions = {
  /** Named hooks for `hooks.call`. */
  hooks?: Record<string, TestHook>;
  /** Further routes, by first path segment. */
  routes?: Record<string, TestRoute>;
  /** What else `reset` empties, after D1, core's bucket and caches (a module's buckets). */
  reset?: (env: Env) => Promise<void>;
  /** Answers some outgoing requests inside the Worker instead (an offline DNS, say). */
  answer?: (request: Request) => Response | undefined;
};

type QueueOutcome = {
  ack: boolean;
  retry: boolean;
  retryDelaySeconds: number | undefined;
};

/** An execution context whose `waitUntil` work the hook awaits before answering. */
function settlingContext(ctx: ExecutionContext) {
  const pending: Promise<unknown>[] = [];

  const context: ExecutionContext = {
    waitUntil: (promise) => void pending.push(promise),
    passThroughOnException: () => ctx.passThroughOnException(),
    abort: (reason) => ctx.abort(reason),
    get exports() {
      return ctx.exports;
    },
    get props() {
      return ctx.props;
    },
    get cache() {
      return ctx.cache;
    },
    get access() {
      return ctx.access;
    },
    get tracing() {
      return ctx.tracing;
    },
  };

  // Work may start more work: settles until none is left, oldest first.
  const settle = async (): Promise<string[]> => {
    if (!pending.length) return [];
    const results = await Promise.allSettled(pending.splice(0));

    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [String(result.reason)] : []
    );

    return [...errors, ...(await settle())];
  };

  return { context, settle };
}

function runStatement(db: D1Database, call: D1Call) {
  const statement = db.prepare(call.sql).bind(...(call.params ?? []));

  switch (call.method ?? "all") {
    case "first": {
      return call.column === undefined
        ? statement.first()
        : statement.first(call.column);
    }

    case "run": {
      return statement.run();
    }

    case "raw": {
      return call.columnNames
        ? statement.raw({ columnNames: true })
        : statement.raw();
    }

    default: {
      return statement.all();
    }
  }
}

/** Empties every table but D1's own and the migrations log. */
async function clearDatabase(db: D1Database) {
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'"
    )
    .all<{ name: string }>();

  if (!results.length) return;
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = on"),
    ...results.map(({ name }) => db.prepare(`DELETE FROM "${name}"`)),
  ]);
}

export function clearBucket(bucket: R2Bucket) {
  // A page at a time, each listed after the one before is deleted.
  const clearFrom = async (cursor?: string): Promise<void> => {
    const listed = await bucket.list({ cursor, limit: 1000 });

    if (listed.objects.length) {
      await bucket.delete(listed.objects.map((object) => object.key));
    }

    if (listed.truncated) await clearFrom(listed.cursor);
  };

  return clearFrom();
}

function objectInfo(object: R2Object) {
  return {
    key: object.key,
    size: object.size,
    etag: object.etag,
    uploaded: object.uploaded,
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  };
}

async function runBucket(bucket: R2Bucket, call: R2Call) {
  switch (call.op) {
    case "put": {
      const object = await bucket.put(call.key, call.body, call.options);

      return object && objectInfo(object);
    }

    case "get": {
      const object = await bucket.get(call.key);

      return (
        object && {
          ...objectInfo(object),
          body: new Uint8Array(await object.arrayBuffer()),
        }
      );
    }

    case "head": {
      const object = await bucket.head(call.key);

      return object && objectInfo(object);
    }

    case "delete": {
      return bucket.delete(call.key);
    }

    case "list": {
      const listed = await bucket.list(call.options);

      return { ...listed, objects: listed.objects.map(objectInfo) };
    }

    default: {
      const unexpected: never = call;
      throw new Error(`Unknown R2 call ${JSON.stringify(unexpected)}`);
    }
  }
}

/** The R2 bucket bound to the Worker as `name`. */
function bucketBinding(env: Env, name: string) {
  const binding = new Map(Object.entries(env)).get(name);

  return z
    .custom<R2Bucket>(
      (value) => value instanceof Object && "head" in value && "list" in value,
      `No R2 bucket is bound as ${name}`
    )
    .parse(binding);
}

/** The Worker's string bindings (keys, settings) by name; undefined for any other. */
function envValue(env: Env, name: string) {
  return z
    .string()
    .optional()
    .catch(undefined)
    .parse(new Map(Object.entries(env)).get(name));
}

/**
 * A test Worker's wrap: takes the workspace's handlers and returns them with
 * the test routes and outgoing-request routing.
 */
export const testWorker =
  (options: TestHookOptions = {}) =>
  (workspace: Handlers) =>
    withTestHooks(workspace, options);

function withTestHooks(workspace: Handlers, options: TestHookOptions) {
  const testProcess = z
    .object({
      TEST_HOOKS: z.string({
        error: "A test Worker needs TEST_HOOKS, the test process's URL",
      }),
    })
    .parse(workerEnv).TEST_HOOKS;

  routeOutboundFetch(testProcess, options.answer);
  const hooks = testHooks(workspace, options);

  return {
    ...workspace,
    fetch(request, env, ctx) {
      if (new URL(request.url).pathname.startsWith(TEST_HOOKS_PATH)) {
        return hooks(request, env, ctx);
      }

      return workspace.fetch(request, env, ctx);
    },
  } satisfies ExportedHandler<Env>;
}

function testHooks(workspace: Handlers, options: TestHookOptions) {
  return async (
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> => {
    const [route = "", ...path] = new URL(request.url).pathname
      .slice(TEST_HOOKS_PATH.length)
      .split("/");

    const input =
      request.method === "POST" ? decode(await request.text()) : undefined;

    const reply = <T>(value: T) =>
      new Response(encode(value), {
        headers: { "content-type": "application/json" },
      });

    const { context, settle } = settlingContext(ctx);

    switch (route) {
      // A pristine workspace: empty tables and buckets, nothing cached from before.
      case "reset": {
        await clearDatabase(env.DB);
        await clearBucket(env.MEDIA);

        if (env.BACKUP_STORAGE) await clearBucket(env.BACKUP_STORAGE);
        await options.reset?.(env);
        resetDeclaredSsoApps();
        resetDeclaredWebhooks();

        return reply(null);
      }

      case "d1": {
        const calls = d1Input.parse(input);

        if (!Array.isArray(calls)) {
          return reply(await runStatement(env.DB, calls));
        }

        const statements = calls.map((call) =>
          env.DB.prepare(call.sql).bind(...(call.params ?? []))
        );

        return reply(await env.DB.batch(statements));
      }

      case "r2": {
        const call = r2Call.parse(input);

        return reply(await runBucket(bucketBinding(env, call.binding), call));
      }

      case "env": {
        const names = envNames.parse(input);

        return reply(
          Object.fromEntries(names.map((name) => [name, envValue(env, name)]))
        );
      }

      // Runs the Worker's queue handler on a hand-made batch from the queue
      // of this role, by its deployed name, and reports each message's outcome.
      case "queue": {
        const { role, messages } = queueCall.parse(input);

        const queue = new Map(
          Object.entries(
            z.record(z.string(), z.string()).parse(JSON.parse(env.QUEUE_NAMES))
          )
        ).get(role);

        if (!queue) {
          return reply({
            outcomes: [],
            error: `No queue has the role ${role}`,
            background: [],
          });
        }

        const outcomes: QueueOutcome[] = messages.map(() => ({
          ack: false,
          retry: false,
          retryDelaySeconds: undefined,
        }));

        const batch: MessageBatch<Decoded> = {
          queue,
          messages: messages.map((message, index) => {
            const outcome = required(outcomes[index], "an outcome per message");

            return {
              id: message.id ?? crypto.randomUUID(),
              timestamp: message.timestamp ?? new Date(),
              body: message.body,
              attempts: message.attempts ?? 1,
              ack: () => void (outcome.ack = true),
              retry: (retryOptions) => {
                outcome.retry = true;
                outcome.retryDelaySeconds = retryOptions?.delaySeconds;
              },
            };
          }),
          metadata: {
            metrics: { backlogCount: messages.length, backlogBytes: 0 },
          },
          ackAll: () => outcomes.forEach((outcome) => (outcome.ack = true)),
          retryAll: (retryOptions) =>
            outcomes.forEach((outcome) => {
              outcome.retry = true;
              outcome.retryDelaySeconds = retryOptions?.delaySeconds;
            }),
        };

        let error: string | undefined;

        try {
          await workspace.queue(batch, env, context);
        } catch (thrown) {
          error = thrown instanceof Error ? thrown.message : String(thrown);
        }

        return reply({ outcomes, error, background: await settle() });
      }

      // Inbound mail as Email Routing hands it to the Worker.
      case "email": {
        const { from, to, raw, headers } = emailCall.parse(input);
        let rejection: string | undefined;

        const forwarded: { to: string; headers?: [string, string][] }[] = [];

        const bytes = new TextEncoder().encode(raw);

        const message: ForwardableEmailMessage = {
          from,
          to,
          raw: new Blob([bytes]).stream(),
          headers: new Headers(headers),
          rawSize: bytes.byteLength,
          setReject: (reason) => void (rejection = reason),
          forward: (address, extra) => {
            forwarded.push({
              to: address,
              headers: extra ? [...extra] : undefined,
            });

            return Promise.resolve({ messageId: "" });
          },
          reply: () => Promise.resolve({ messageId: "" }),
        };

        await workspace.email(message, env, context);

        return reply({ rejection, forwarded, background: await settle() });
      }

      case "scheduled": {
        const { cron = "17 * * * *", scheduledTime = Date.now() } =
          scheduledCall.parse(input) ?? {};

        const controller: ScheduledController = {
          cron,
          scheduledTime,
          noRetry() {},
        };

        await workspace.scheduled(controller, env, context);

        return reply({ background: await settle() });
      }

      // A request handled like any other, answered once its background work is done.
      case "fetch": {
        const call = fetchCall.parse(input);

        // SAFETY: a Request made here has no `cf` (it stays undefined); the
        // type parameter only describes the `cf` an incoming request carries.
        const forwarded = new Request(call.url, {
          method: call.method,
          headers: call.headers,
          body: call.body,
        }) as Request<unknown, IncomingRequestCfProperties>;

        const response = await workspace.fetch(forwarded, env, context);

        const body = new Uint8Array(await response.arrayBuffer());

        return reply({
          status: response.status,
          headers: [...response.headers],
          body,
          background: await settle(),
        });
      }

      // A named hook, for what only Worker code can do.
      case "call": {
        const name = decodeURIComponent(path[0] ?? "");
        const hook = options.hooks?.[name];

        if (!hook) return new Response(`No test hook ${name}`, { status: 404 });
        const { args } = hookCall.parse(input);

        // SAFETY: the test-side signature is the hook's own: `hooks.call`
        // sends the arguments the test wrote against it, and the codec
        // brings them back as they were sent. Only this HTTP hop has no
        // type, as with any RPC.
        const call = hook as (
          context: HookContext,
          ...args: Decoded[]
        ) => ReturnType<TestHook>;

        const result = await call({ env, ctx: context }, ...args);

        return reply({ result, background: await settle() });
      }

      default: {
        const handler = options.routes?.[route];

        if (!handler) return new Response("No such test hook", { status: 404 });

        const result = await handler({ env, ctx: context, input, path });

        return result instanceof Response ? result : reply(result);
      }
    }
  };
}
