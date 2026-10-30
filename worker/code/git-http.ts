import { authenticateAccountApiToken, bearerToken } from "../auth/api-tokens";
import { createDb } from "../db/client";
import type { SessionUser } from "../env";
import {
  forgetGitUpstream,
  gitUpstream,
  type ArtifactsBindings,
} from "./artifacts";
import {
  PktLineError,
  readReceivePackHead,
  rejectedReceivePackResult,
} from "./pkt-line";
import { authorizeRefUpdates } from "./ref-policy";
import { findRepository, listBranchProtections } from "./repositories";

/**
 * Git smart HTTP endpoint: `https://<workspace>/<repo>.git`.
 *
 * Clients authenticate with a workspace API token (Basic password or Bearer).
 * Ref updates are authorized here, before the packfile is forwarded, because
 * Artifacts push events only arrive after a push has been accepted.
 */

const GIT_PATH = /^\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u;
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-encoding",
  "content-type",
  "git-protocol",
  "user-agent",
];
const FORWARDED_RESPONSE_HEADERS = [
  "cache-control",
  "content-encoding",
  "content-type",
  "expires",
  "pragma",
];

type GitService = "git-upload-pack" | "git-receive-pack";

export type GitHttpEnv = ArtifactsBindings & { DB: D1Database };

export type GitHttpDependencies = {
  fetch: typeof fetch;
};

export function isGitHttpPath(pathname: string) {
  return GIT_PATH.test(pathname);
}

function textResponse(status: number, message: string, headers?: HeadersInit) {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

function credential(request: Request) {
  const authorization = request.headers.get("authorization");
  const basic = authorization?.match(/^Basic\s+([A-Za-z0-9+/=]+)$/iu)?.[1];
  if (basic) {
    try {
      const decoded = atob(basic);
      return decoded.slice(decoded.indexOf(":") + 1) || null;
    } catch {
      return null;
    }
  }
  return bearerToken(request);
}

async function authenticate(request: Request, db: D1Database) {
  const token = credential(request);
  const identity = token ? await authenticateAccountApiToken(db, token) : null;
  return identity?.user ?? null;
}

function requestedService(request: Request, action: string): GitService | null {
  if (action === "info/refs") {
    if (request.method !== "GET") return null;
    const service = new URL(request.url).searchParams.get("service");
    return service === "git-upload-pack" || service === "git-receive-pack"
      ? service
      : null;
  }
  return request.method === "POST" ? action as GitService : null;
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

function prepend(
  prefix: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.byteLength > 0) controller.enqueue(prefix);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

type ReceivePackDecision =
  | { allowed: true; body: ReadableStream<Uint8Array>; gzip: boolean }
  | { allowed: false; response: Response };

async function authorizeReceivePack(
  request: Request,
  user: SessionUser,
  rulesLoader: () => ReturnType<typeof listBranchProtections>,
): Promise<ReceivePackDecision> {
  if (!request.body) {
    return { allowed: false, response: textResponse(400, "Push body is empty") };
  }
  const gzip = request.headers.get("content-encoding") === "gzip";
  const reader = (gzip
    ? request.body.pipeThrough(new DecompressionStream("gzip"))
    : request.body
  ).getReader();

  let head;
  try {
    head = await readReceivePackHead(reader);
  } catch (error) {
    if (error instanceof PktLineError) {
      await reader.cancel().catch(() => undefined);
      return { allowed: false, response: textResponse(400, error.message) };
    }
    throw error;
  }

  const reasons = authorizeRefUpdates(user, head.commands, await rulesLoader());
  if (reasons.size === 0) {
    const prefix = new Uint8Array(head.head.byteLength + head.rest.byteLength);
    prefix.set(head.head);
    prefix.set(head.rest, head.head.byteLength);
    // The upstream receives the decompressed stream, so drop the encoding.
    return { allowed: true, body: prepend(prefix, reader), gzip };
  }

  // Consume the packfile so the client reads our status instead of a reset.
  await drain(reader);
  const report = rejectedReceivePackResult(head.commands, head.capabilities, reasons);
  if (!report) {
    return {
      allowed: false,
      response: textResponse(403, [...new Set(reasons.values())].join("; ")),
    };
  }
  return {
    allowed: false,
    response: new Response(report, {
      headers: {
        "content-type": "application/x-git-receive-pack-result",
        "cache-control": "no-cache",
      },
    }),
  };
}

export async function handleGitHttp(
  request: Request,
  env: GitHttpEnv,
  // Wrap the global so it is never invoked with `this` bound to this object,
  // which the Workers runtime rejects as an illegal invocation.
  dependencies: GitHttpDependencies = { fetch: (input, init) => fetch(input, init) },
) {
  const url = new URL(request.url);
  const match = url.pathname.match(GIT_PATH);
  if (!match) return textResponse(404, "Not found");
  const [, name, action] = match as unknown as [string, string, string];

  const service = requestedService(request, action);
  if (!service) return textResponse(400, "Unsupported Git request");

  const user = await authenticate(request, env.DB);
  if (!user) {
    return textResponse(401, "Authentication is required", {
      "www-authenticate": 'Basic realm="OpenWorkspace Git", charset="UTF-8"',
    });
  }

  const db = createDb(env.DB);
  const repository = await findRepository(db, name);
  if (!repository) return textResponse(404, "Repository not found");

  const headers = new Headers();
  for (const header of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(header);
    if (value) headers.set(header, value);
  }

  let body: ReadableStream<Uint8Array> | null = null;
  if (action === "git-receive-pack") {
    const decision = await authorizeReceivePack(
      request,
      user,
      () => listBranchProtections(db, repository.id),
    );
    if (!decision.allowed) return decision.response;
    body = decision.body;
    if (decision.gzip) headers.delete("content-encoding");
  } else if (action === "git-upload-pack") {
    body = request.body;
  }

  const scope = service === "git-receive-pack" ? "write" : "read";
  const upstream = await gitUpstream(env, repository.artifactsName, scope);
  headers.set("authorization", upstream.authorization);
  const response = await dependencies.fetch(
    `${upstream.remote}/${action}${url.search}`,
    { method: request.method, headers, body },
  );

  if (response.status === 401 || response.status === 403) {
    // Our cached token was revoked or expired early; the next request mints one.
    forgetGitUpstream(repository.artifactsName);
    console.error("Artifacts rejected the proxy credential", response.status);
    return textResponse(502, "Git storage rejected the request");
  }

  const responseHeaders = new Headers();
  for (const header of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }
  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}
