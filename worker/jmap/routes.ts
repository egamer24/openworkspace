import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { MAX_COMPOSER_ATTACHMENT_BYTES } from "../../shared/mail";
import { authenticateAccountApiToken, bearerToken } from "../auth/api-tokens";
import type { AppEnv } from "../env";
import { hashToken } from "../lib/crypto";
import { checkRateLimit } from "../lib/rate-limit";
import { mailboxStub } from "../mailbox";
import { UploadValidationError } from "../mail/uploads";
import { loadUploadedBlob, storeUploadedBlob } from "./blobs";
import {
  CORE,
  LIMITS,
  loadAccount,
  MAIL,
  METHODS,
  MethodError,
  SUBMISSION,
  type Account,
  type RequestContext,
} from "./methods";
import { parseScopedId } from "./ids";
import { eventSource } from "./push";

const CAPABILITIES = [CORE, MAIL, SUBMISSION];
const RATE_LIMIT_PER_MINUTE = 600;

type JmapEnv = AppEnv & { Variables: { jmapAccount: Account } };

function problem(c: Context, status: 400 | 401 | 403 | 404 | 411 | 413 | 429, type: string, detail: string, extra: object = {}) {
  return c.json({ type, status, detail, ...extra }, status, {
    "content-type": "application/problem+json",
  });
}

/**
 * JMAP clients cannot use passkeys, so they authenticate with a personal
 * account API token as a Bearer token or as the HTTP Basic password (the
 * username is ignored). Tokens are looked up on every request, so revoking
 * one takes effect immediately. Browser cookies are deliberately not accepted.
 */
const requireJmapAuth = createMiddleware<JmapEnv>(async (c, next) => {
  let token = bearerToken(c.req.raw);
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/iu.exec(c.req.header("authorization") ?? "");
  if (!token && basic) {
    try {
      const decoded = atob(basic[1]!);
      token = decoded.slice(decoded.indexOf(":") + 1) || null;
    } catch {
      token = null;
    }
  }
  const identity = token ? await authenticateAccountApiToken(c.env.DB, token) : null;
  if (!identity) {
    c.header("www-authenticate", 'Basic realm="OpenWorkspace JMAP", Bearer realm="OpenWorkspace JMAP"');
    return problem(c, 401, "about:blank", "Authentication is required");
  }
  // JMAP exposes whole mailboxes; send-only tokens stay on their REST allowlist.
  if (identity.scope !== "full") {
    return problem(c, 403, "about:blank", "This token can only send mail; JMAP needs a full-access token");
  }
  const limit = await checkRateLimit(c.env.DB, {
    action: "jmap",
    identifier: identity.tokenId,
    limit: RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    c.header("retry-after", String(limit.retryAfterSeconds));
    return problem(c, 429, "urn:ietf:params:jmap:error:limit", "Too many requests", { limit: "rateLimit" });
  }
  c.set("user", identity.user);
  c.set("authKind", "api-token");
  c.set("sessionId", identity.tokenId);
  c.set("sessionTokenHash", identity.tokenHash);
  c.set("jmapAccount", await loadAccount(c.env, identity.user));
  await next();
});

async function sessionState(account: Account) {
  const fingerprint = account.mailboxes
    .map((mailbox) => `${mailbox.id}:${mailbox.canSend}:${mailbox.address}`)
    .join("\n");
  return (await hashToken(fingerprint)).slice(0, 16);
}

function sessionResource(origin: string, account: Account, state: string) {
  return {
    capabilities: {
      [CORE]: LIMITS,
      [MAIL]: {},
      [SUBMISSION]: {},
    },
    accounts: {
      [account.id]: {
        name: account.name,
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          [MAIL]: {
            maxMailboxesPerEmail: null,
            maxMailboxDepth: 2,
            maxSizeMailboxName: 80,
            maxSizeAttachmentsPerEmail: MAX_COMPOSER_ATTACHMENT_BYTES,
            emailQuerySortOptions: ["receivedAt", "sentAt"],
            mayCreateTopLevelMailbox: false,
          },
          [SUBMISSION]: { maxDelayedSend: 0, submissionExtensions: {} },
        },
      },
    },
    primaryAccounts: { [MAIL]: account.id, [SUBMISSION]: account.id },
    username: account.name,
    apiUrl: `${origin}/jmap/api`,
    downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${origin}/jmap/upload/{accountId}`,
    eventSourceUrl: `${origin}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
    state,
  };
}

// --- Result references (RFC 8620 section 3.7) ------------------------------

function evaluatePointer(value: unknown, tokens: string[]): unknown {
  if (!tokens.length) return value;
  const [token, ...rest] = tokens;
  if (Array.isArray(value)) {
    if (token === "*") {
      return value.flatMap((item) => {
        const result = evaluatePointer(item, rest);
        return Array.isArray(result) ? result : [result];
      });
    }
    if (!/^(?:0|[1-9]\d*)$/u.test(token!) || Number(token) >= value.length) throw new Error("Bad index");
    return evaluatePointer(value[Number(token)], rest);
  }
  if (typeof value === "object" && value !== null && Object.hasOwn(value, token!)) {
    return evaluatePointer((value as Record<string, unknown>)[token!], rest);
  }
  throw new Error("Path not found");
}

function resolveReferences(
  args: Record<string, unknown>,
  responses: Array<[string, Record<string, unknown>, string]>,
) {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("#")) {
      resolved[key] = value;
      continue;
    }
    const name = key.slice(1);
    if (Object.hasOwn(args, name)) {
      throw new MethodError("invalidArguments", `${name} is given both directly and as a reference`);
    }
    const reference = value as { resultOf?: unknown; name?: unknown; path?: unknown } | null;
    const response = responses.find(
      ([responseName, , callId]) => callId === reference?.resultOf && responseName === reference?.name,
    );
    if (!response || typeof reference?.path !== "string" || !/^(?:|\/.*)$/u.test(reference.path)) {
      throw new MethodError("invalidResultReference");
    }
    const tokens = reference.path === ""
      ? []
      : reference.path.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
    try {
      resolved[name] = evaluatePointer(response[1], tokens);
    } catch {
      throw new MethodError("invalidResultReference");
    }
  }
  return resolved;
}

function isRequest(value: unknown): value is {
  using: string[];
  methodCalls: Array<[string, Record<string, unknown>, string]>;
  createdIds?: Record<string, string>;
} {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return Array.isArray(request.using)
    && request.using.every((item) => typeof item === "string")
    && Array.isArray(request.methodCalls)
    && request.methodCalls.every((call) =>
      Array.isArray(call) && call.length === 3 && typeof call[0] === "string"
      && typeof call[1] === "object" && call[1] !== null && !Array.isArray(call[1])
      && typeof call[2] === "string"
    )
    && (request.createdIds === undefined
      || (typeof request.createdIds === "object" && request.createdIds !== null));
}

/** Creation ids of Email drafts that a later EmailSubmission/set will send. */
function submittedDraftRefs(methodCalls: Array<[string, Record<string, unknown>, string]>) {
  const refs = new Set<string>();
  for (const [name, args] of methodCalls) {
    if (name !== "EmailSubmission/set" || typeof args.create !== "object" || args.create === null) continue;
    for (const submission of Object.values(args.create)) {
      const emailId = (submission as { emailId?: unknown } | null)?.emailId;
      if (typeof emailId === "string" && emailId.startsWith("#")) refs.add(emailId.slice(1));
    }
  }
  return refs;
}

function blobHeaders(c: Context, storedType: string) {
  const requestedType = c.req.query("type");
  return {
    "content-type": requestedType && /^[\w.+-]+\/[\w.+-]+(?:\s*;.*)?$/u.test(requestedType)
      ? requestedType
      : storedType,
    // Blobs are never rendered on this origin.
    "content-disposition": contentDisposition(c.req.param("name") ?? "blob"),
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": "private, max-age=3600",
  };
}

function contentDisposition(name: string) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export const jmapRoutes = new Hono<JmapEnv>()
  .get("/.well-known/jmap", requireJmapAuth, async (c) => {
    const account = c.get("jmapAccount");
    return c.json(sessionResource(new URL(c.req.url).origin, account, await sessionState(account)));
  })
  .post("/jmap/api", requireJmapAuth, async (c) => {
    const declaredLength = Number(c.req.header("content-length") ?? 0);
    if (declaredLength > LIMITS.maxSizeRequest) {
      return problem(c, 400, "urn:ietf:params:jmap:error:limit", "Request is too large", { limit: "maxSizeRequest" });
    }
    const body = await c.req.text();
    if (new TextEncoder().encode(body).byteLength > LIMITS.maxSizeRequest) {
      return problem(c, 400, "urn:ietf:params:jmap:error:limit", "Request is too large", { limit: "maxSizeRequest" });
    }
    let request: unknown;
    try {
      request = JSON.parse(body);
    } catch {
      return problem(c, 400, "urn:ietf:params:jmap:error:notJSON", "Request body is not JSON");
    }
    if (!isRequest(request)) {
      return problem(c, 400, "urn:ietf:params:jmap:error:notRequest", "Request does not match the JMAP Request type");
    }
    const unknown = request.using.find((capability) => !CAPABILITIES.includes(capability));
    if (unknown) {
      return problem(c, 400, "urn:ietf:params:jmap:error:unknownCapability", `Unknown capability ${unknown}`);
    }
    if (request.methodCalls.length > LIMITS.maxCallsInRequest) {
      return problem(c, 400, "urn:ietf:params:jmap:error:limit", "Too many method calls", { limit: "maxCallsInRequest" });
    }

    const account = c.get("jmapAccount");
    const ctx: RequestContext = {
      env: c.env,
      requestUrl: c.req.url,
      account,
      defer: (task) => c.executionCtx.waitUntil(task),
      createdIds: new Map(Object.entries(request.createdIds ?? {})),
      drafts: new Map(),
      submittedDraftRefs: submittedDraftRefs(request.methodCalls),
    };
    const responses: Array<[string, Record<string, unknown>, string]> = [];
    for (const [name, rawArgs, callId] of request.methodCalls) {
      const method = METHODS[name];
      try {
        if (!method || !request.using.includes(method.capability)) throw new MethodError("unknownMethod");
        const args = resolveReferences(rawArgs, responses);
        for (const [responseName, responseArgs] of await method.handler(ctx, args)) {
          responses.push([responseName, responseArgs, callId]);
        }
      } catch (error) {
        if (error instanceof MethodError) {
          responses.push(["error", {
            type: error.type,
            ...(error.message !== error.type ? { description: error.message } : {}),
            ...error.extra,
          }, callId]);
        } else {
          console.error(`JMAP ${name} failed`, error);
          responses.push(["error", { type: "serverFail" }, callId]);
        }
      }
    }
    return c.json({
      methodResponses: responses,
      sessionState: await sessionState(account),
      ...(request.createdIds ? { createdIds: Object.fromEntries(ctx.createdIds) } : {}),
    });
  })
  .get("/jmap/download/:accountId/:blobId/:name", requireJmapAuth, async (c) => {
    const account = c.get("jmapAccount");
    const notFound = () => problem(c, 404, "about:blank", "Blob not found");
    if (c.req.param("accountId") !== account.id) return notFound();
    const uploaded = await loadUploadedBlob(c.env, account.userId, c.req.param("blobId"));
    if (uploaded) {
      const object = await c.env.MAIL_STORAGE.get(uploaded.r2Key);
      if (!object) return notFound();
      return new Response(object.body, { headers: blobHeaders(c, uploaded.contentType) });
    }
    const blob = parseScopedId(c.req.param("blobId"));
    if (
      c.req.param("accountId") !== account.id || !blob
      || !account.mailboxes.some((mailbox) => mailbox.id === blob.mailboxId)
    ) {
      return notFound();
    }
    const email = await mailboxStub(c.env, blob.mailboxId).getEmail(blob.objectId);
    if (!email) return notFound();
    let body: ReadableStream | string | null = null;
    let storedType = "application/octet-stream";
    if (blob.part === undefined || blob.part === "_html") {
      const key = blob.part === undefined ? email.rawMimeR2Key : email.bodyHtmlR2Key;
      const object = key ? await c.env.MAIL_STORAGE.get(key) : null;
      body = object?.body ?? null;
      storedType = blob.part === undefined ? "message/rfc822" : "text/html; charset=utf-8";
    } else if (blob.part === "_text") {
      body = [email.bodyText, email.quotedText].filter(Boolean).join("\n\n");
      storedType = "text/plain; charset=utf-8";
    } else {
      const file = email.attachmentsJson.find((attachment) => attachment.id === blob.part);
      const object = file ? await c.env.MAIL_STORAGE.get(file.r2Key) : null;
      body = object?.body ?? null;
      storedType = file?.contentType ?? storedType;
    }
    if (body === null) return notFound();
    return new Response(body, { headers: blobHeaders(c, storedType) });
  })
  .post("/jmap/upload/:accountId", requireJmapAuth, async (c) => {
    const account = c.get("jmapAccount");
    if (c.req.param("accountId") !== account.id) return problem(c, 404, "about:blank", "Account not found");
    const length = c.req.header("content-length");
    if (length === undefined || !/^\d+$/u.test(length)) {
      return problem(c, 411, "about:blank", "Content-Length is required");
    }
    if (Number(length) > LIMITS.maxSizeUpload) {
      return problem(c, 413, "urn:ietf:params:jmap:error:limit", "Blob is too large", { limit: "maxSizeUpload" });
    }
    const type = (c.req.header("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    const contentType = /^[\w.+-]+\/[\w.+-]+$/u.test(type) ? type : "application/octet-stream";
    try {
      // The runtime holds a Content-Length body to its declared size, so the
      // stream goes to R2 without buffering.
      const blob = await storeUploadedBlob(c.env, account.userId, contentType, c.req.raw.body ?? new ArrayBuffer(0));
      return c.json({ accountId: account.id, blobId: blob.id, type: blob.contentType, size: blob.size }, 201);
    } catch (error) {
      if (error instanceof UploadValidationError) return problem(c, 400, "about:blank", "The blob is empty");
      throw error;
    }
  })
  .get("/jmap/eventsource", requireJmapAuth, (c) => eventSource({
    env: c.env,
    account: c.get("jmapAccount"),
    tokenId: c.get("sessionId"),
    tokenHash: c.get("sessionTokenHash"),
    url: new URL(c.req.url),
    signal: c.req.raw.signal,
  }));
