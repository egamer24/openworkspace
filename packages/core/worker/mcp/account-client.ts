import type { Context } from "hono";
import { z } from "zod";

import { accountApi } from "../account-api";
import type { AppEnv } from "../env";
import { jsonObjectSchema, jsonValueSchema } from "../lib/json";
import type { JsonObject, JsonValue } from "../lib/json";

type HonoExecutionContext = Context<AppEnv>["executionCtx"];

// SAFETY: Hono intentionally exposes the runtime-compatible subset of
// Cloudflare's ExecutionContext. Wrangler's generated type also requires
// tracing helpers, even though Hono neither consumes nor forwards them through
// sub-app fetches, so the request's own context is all `fetch` uses.
const fetchAccountApi = (
  request: Request,
  env: Env,
  executionCtx: HonoExecutionContext
) =>
  (
    accountApi().fetch as (
      request: Request,
      env: Env,
      executionCtx: HonoExecutionContext
    ) => Response | Promise<Response>
  )(request, env, executionCtx);

export class AccountApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "AccountApiError";
  }
}

/** The `{ ok: false, error }` body of a refused request (`apiError`). */
const accountApiErrorSchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

/** The body as JSON, or undefined when it isn't JSON. */
function parseJson(payload: string): JsonValue | undefined {
  try {
    return jsonValueSchema.parse(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

/** The refusal an error body describes, falling back to the bare text. */
function accountApiError(response: Response, payload: string) {
  const body = accountApiErrorSchema.safeParse(parseJson(payload)).data;

  return new AccountApiError(
    body?.error?.message ?? (payload || `Request failed (${response.status})`),
    response.status,
    body?.error?.code
  );
}

export type AccountApiBinary = {
  bytes: Uint8Array;
  contentType: string;
  filename: string | null;
  offsetBytes: number;
  totalBytes: number;
};

function filenameFromDisposition(value: string | null) {
  const encoded = value?.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];

  if (!encoded) return null;

  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function binaryRange(response: Response, returnedBytes: number) {
  const contentRange = response.headers
    .get("content-range")
    ?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);

  return contentRange
    ? {
        offsetBytes: Number(contentRange[1]),
        totalBytes: Number(contentRange[3]),
      }
    : {
        offsetBytes: 0,
        totalBytes:
          Number(response.headers.get("content-length")) || returnedBytes,
      };
}

export class AccountApiClient {
  constructor(
    private readonly env: Env,
    private readonly executionCtx: HonoExecutionContext,
    private readonly token: string,
    private readonly publicOrigin: string
  ) {}

  async json(
    path: string,
    init: {
      method?: string;
      json?: unknown;
      body?: BodyInit;
      headers?: HeadersInit;
    } = {}
  ): Promise<JsonObject> {
    const response = await this.request(path, init);
    const payload = await response.text();

    if (!response.ok) throw accountApiError(response, payload);
    const body = jsonObjectSchema.safeParse(parseJson(payload));

    if (!body.success) {
      throw new Error("Account API returned an invalid response");
    }

    return body.data;
  }

  async binary(
    path: string,
    input: { offsetBytes: number; maxBytes: number }
  ): Promise<AccountApiBinary> {
    const response = await this.request(path, {
      headers: {
        range: `bytes=${input.offsetBytes}-${input.offsetBytes + input.maxBytes - 1}`,
      },
    });

    if (!response.ok) {
      // Binary endpoints may return a plain-text platform error.
      throw accountApiError(response, await response.text());
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    return {
      bytes,
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
      filename: filenameFromDisposition(
        response.headers.get("content-disposition")
      ),
      ...binaryRange(response, bytes.byteLength),
    };
  }

  private request(
    path: string,
    init: {
      method?: string;
      json?: unknown;
      body?: BodyInit;
      headers?: HeadersInit;
    } = {}
  ) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    let { body } = init;

    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }

    return fetchAccountApi(
      new Request(new URL(path, this.publicOrigin), {
        method: init.method ?? "GET",
        headers,
        body,
      }),
      this.env,
      this.executionCtx
    );
  }
}

export function apiPath(
  pathname: string,
  query: Record<string, string | number | boolean | null | undefined> = {}
) {
  const url = new URL(pathname, "https://account-api.internal");

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return `${url.pathname}${url.search}`;
}
