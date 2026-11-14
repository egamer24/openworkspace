import { beforeAll } from "bun:test";

import type { z } from "zod";

import type { Decoded } from "./codec.ts";
import { decode, decodeAs, encode } from "./codec.ts";
import type {
  D1Call,
  R2Call,
  R2TestListOptions,
  R2TestPutOptions,
  ScheduledCall,
} from "./wire.ts";
import {
  emailResult,
  envValues,
  fetchResult,
  hookResult,
  queueResult,
  r2Listing,
  r2ObjectInfo,
  r2ObjectWithBody,
  scheduledResult,
} from "./wire.ts";

/**
 * A package's deployed test stack (harness.ts), as its stack test files
 * reach it: the Worker over HTTP, and the test-only routes under
 * /api/__test for what the public API does not expose (test-hooks.ts).
 */

/** The origin tests address the Worker by; OIDC and SAML sign for it. */
export const ORIGIN = "http://example.test";

function stackUrl() {
  const url = process.env.STACK_URL;

  if (!url) {
    throw new Error(
      "The test stack is not deployed; run stack tests with the package's `bun run test:stack`"
    );
  }

  return url;
}

/**
 * The Worker, called like `exports.default.fetch`: any origin (usually http://example.test) goes to the
 * deployed stack, the Host header keeps the origin the test used, and
 * redirects come back unfollowed.
 */
/**
 * The client address requests come from unless a test sets
 * CF-Connecting-IP itself. Each test file gets its own (`useFreshWorkspace`):
 * the Workers rate limits count per address in the Worker's memory, which
 * outlives the per-file reset of D1.
 */
let clientIp = randomClientIp();

function randomClientIp() {
  const [a, b] = crypto.getRandomValues(new Uint8Array(2));

  return `198.18.${a}.${b}`;
}

export const worker = {
  async fetch(input: string | URL | Request, init?: RequestInit) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const target = new URL(`${url.pathname}${url.search}`, stackUrl());
    const headers = new Headers(request.headers);
    // Mock sign-in answers only on localhost; the session it opens is good on any host here.
    headers.set(
      "host",
      url.pathname.startsWith("/api/auth/mock/") ? "localhost" : url.host
    );

    if (!headers.has("cf-connecting-ip")) {
      headers.set("cf-connecting-ip", clientIp);
    }

    // A connection per request: when the Worker answers without reading a
    // request body (a 409 before validation), the local dev server resets
    // the next request sent on the same kept-alive connection.
    const body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await request.arrayBuffer();

    return fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      keepalive: false,
    });
  },
};

/** Sends `input` to a test route; the encoded answer. */
async function send<I>(path: string, input: I) {
  const response = await fetch(new URL(`/api/__test/${path}`, stackUrl()), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encode(input ?? null),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Test hook ${path} failed (${response.status}): ${text}`);
  }

  return text;
}

/** Calls one of the test routes defined here, parsing its answer. */
async function callRoute<I, T>(path: string, input: I, schema: z.ZodType<T>) {
  return decodeAs(await send(path, input), schema);
}

/**
 * A decoded answer as the type its caller states. Hooks and a module's own
 * routes answer with Worker values whose types the test names, as it does
 * for an RPC stub's results or D1's `first<T>()`.
 */
function stated<T>(value: Decoded): T {
  // SAFETY: the codec gives back exactly the value the Worker code answered
  // with; T is the caller's statement of that code's result type (the
  // contract of an RPC stub, or of D1's own `all<T>()`), which the test's
  // assertions then check.
  return value as T;
}

/**
 * Calls a test route; email's mailbox route goes through here too. The
 * route parses `input` and answers with the type the caller states.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the input is any value the codec carries (an RPC call's arguments, say), checked by the Worker route that receives it
export async function hook<T>(path: string, input?: unknown): Promise<T> {
  return stated<T>(decode(await send(path, input)));
}

/** Starts each test of the calling file from an empty workspace: no rows in D1, no objects in R2. */
export function useFreshWorkspace() {
  beforeAll(async () => {
    clientIp = randomClientIp();
    await send("reset", null);
  });
}

export const hooks = {
  /**
   * Runs the Worker's queue handler on these messages from the queue of
   * this role (e.g. "webhooks"), like `createMessageBatch` + `getQueueResult`.
   */
  queue(
    role: string,
    // A message body is any value the codec carries.
    messages: {
      id?: string;
      body: unknown;
      attempts?: number;
      timestamp?: Date;
    }[]
  ) {
    return callRoute("queue", { role, messages }, queueResult);
  },
  /** Hands the Worker inbound mail as Email Routing does; the rejection reason, if any. */
  email(message: {
    from: string;
    to: string;
    raw: string;
    headers?: [string, string][];
  }) {
    return callRoute("email", message, emailResult);
  },
  /** Runs the Worker's cron handler and waits for its work. */
  scheduled(input: ScheduledCall = {}) {
    return callRoute("scheduled", input, scheduledResult);
  },
  /** Like `worker.fetch`, but answers once the request's `waitUntil` work is done too. */
  async fetchAndWait(input: string | URL | Request, init?: RequestInit) {
    const request = new Request(input, init);

    if (!request.headers.has("cf-connecting-ip")) {
      request.headers.set("cf-connecting-ip", clientIp);
    }

    const body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : new Uint8Array(await request.arrayBuffer());

    const result = await callRoute(
      "fetch",
      {
        url: request.url,
        method: request.method,
        headers: [...request.headers],
        body,
      },
      fetchResult
    );

    const response = new Response(
      [101, 204, 205, 304].includes(result.status) ? null : result.body,
      { status: result.status, headers: result.headers }
    );

    return Object.assign(response, { background: result.background });
  },
  /** Values of the Worker's bindings: keys, settings. */
  env<K extends string>(...names: K[]): Promise<Record<K, string | undefined>> {
    return callRoute("env", names, envValues);
  },
  /** A named hook the package's test Worker registers (test/stack/hooks.ts). */
  async call<T = Decoded>(name: string, ...args: unknown[]) {
    const { result } = await callRoute(
      `call/${encodeURIComponent(name)}`,
      { args },
      hookResult
    );

    return stated<T>(result);
  },
};

class RemoteStatement {
  constructor(
    readonly sql: string,
    readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]) {
    return new RemoteStatement(this.sql, params);
  }

  private async call<T>(extra: Omit<D1Call, "sql" | "params">) {
    return stated<T>(
      decode(await send("d1", { sql: this.sql, params: this.params, ...extra }))
    );
  }

  first<T = Record<string, Decoded>>(column?: string) {
    return this.call<T | null>({ method: "first", column });
  }

  run<T = Record<string, Decoded>>() {
    return this.call<D1Result<T>>({ method: "run" });
  }

  all<T = Record<string, Decoded>>() {
    return this.call<D1Result<T>>({ method: "all" });
  }

  raw<T = Decoded[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;

  raw<T = Decoded[]>(options?: { columnNames?: false }): Promise<T[]>;

  raw<T = Decoded[]>(options?: { columnNames?: boolean }) {
    return this.call<T[] | [string[], ...T[]]>({
      method: "raw",
      columnNames: options?.columnNames,
    });
  }
}

const notOverHttp = (method: string) =>
  Promise.reject(
    new Error(`The test stack's D1 has no ${method} over the test routes`)
  );

const batch = async <T = Record<string, Decoded>>(
  statements: D1PreparedStatement[]
) =>
  stated<D1Result<T>[]>(
    decode(
      await send(
        "d1",
        statements.map((statement) => {
          if (!(statement instanceof RemoteStatement)) {
            throw new TypeError("Batch statements from env.DB.prepare()");
          }

          return { sql: statement.sql, params: statement.params };
        })
      )
    )
  );

const prepare = (sql: string) => new RemoteStatement(sql);

/**
 * The stack's D1 database, statement by statement over the test routes:
 * enough of D1's API for direct SQL and for Drizzle (`createDb(env.DB)`).
 */
const DB: D1Database = {
  prepare,
  batch,
  exec: () => notOverHttp("exec"),
  dump: () => notOverHttp("dump"),
  // Every statement goes to the primary: a session is the database itself.
  withSession: () => ({ prepare, batch, getBookmark: () => null }),
};

async function bodyBytes(
  body: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null
) {
  if (body === null) return new Uint8Array();

  if (body instanceof ArrayBuffer) return new Uint8Array(body);

  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    );
  }

  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());

  if (body instanceof ReadableStream) {
    return new Uint8Array(await new Response(body).arrayBuffer());
  }

  return new TextEncoder().encode(body);
}

/** An R2 bucket binding of the stack over the test routes, with R2's object shapes. */
export function bucket(binding: string) {
  const call = <T>(input: R2Call, schema: z.ZodType<T>) =>
    callRoute("r2", input, schema);

  return {
    async put(
      key: string,
      body:
        | string
        | ArrayBuffer
        | ArrayBufferView
        | Blob
        | ReadableStream
        | null,
      options?: R2TestPutOptions
    ) {
      return call(
        { binding, op: "put", key, body: await bodyBytes(body), options },
        r2ObjectInfo.nullable()
      );
    },
    async get(key: string) {
      const object = await call(
        { binding, op: "get", key },
        r2ObjectWithBody.nullable()
      );

      if (!object) return null;
      const { body, ...info } = object;

      return {
        ...info,
        get body() {
          return new Blob([body]).stream();
        },
        text: () => Promise.resolve(new TextDecoder().decode(body)),
        /** The object's JSON, parsed with `schema`. */
        json: <T>(schema: z.ZodType<T>) =>
          Promise.resolve(
            schema.parse(JSON.parse(new TextDecoder().decode(body)))
          ),
        arrayBuffer: () => Promise.resolve(body.slice().buffer),
        bytes: () => Promise.resolve(body),
      };
    },
    head: (key: string) =>
      call({ binding, op: "head", key }, r2ObjectInfo.nullable()),
    delete: (keys: string | string[]) =>
      Promise.all(
        (Array.isArray(keys) ? keys : [keys]).map((key) =>
          send("r2", { binding, op: "delete", key })
        )
      ).then(() => undefined),
    list: (options?: R2TestListOptions) =>
      call({ binding, op: "list", options }, r2Listing),
  };
}

/** The stack's bindings tests read and write directly (a module's test client adds its buckets). */
export const env = {
  DB,
  MEDIA: bucket("MEDIA"),
  BACKUP_STORAGE: bucket("BACKUP_STORAGE"),
};
