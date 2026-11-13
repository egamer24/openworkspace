import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { required } from "../../shared/invariant";
import { isPrivilegedScope } from "../../shared/oidc";
import type { Database } from "../db/client";
import { oidcAccessTokens, oidcClients, settings, users } from "../db/schema";
import type { AppEnv, SessionUser } from "../env";
import { hashToken } from "../lib/crypto";
import { createId } from "../lib/ids";
import { readBounded } from "../lib/stream";
import { OidcError } from "./errors";
import { oidcIssuer } from "./keys";
import {
  coveredScopes,
  defaultSelfRegisteredScopes,
  scopeDefinitions,
  workspaceScopeIds,
} from "./scopes";
import { assertUserCanUseClient, findEnabledClient } from "./service";
import type { OidcClient } from "./service";
import { isAllowedOidcRedirectUri } from "./validation";

const METADATA_DOCUMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** A cached document still serves while its host is briefly unreachable. */
const METADATA_DOCUMENT_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const METADATA_DOCUMENT_MAX_BYTES = 16 * 1024;
const METADATA_FETCH_TIMEOUT_MS = 5000;
const MAX_CLIENT_NAME = 100;
const MAX_REDIRECT_URIS = 10;

export function isSelfRegisteredClient(
  client: Pick<OidcClient, "registration">
) {
  return client.registration !== "admin";
}

/** Where a self-registered client comes from: its metadata document's host, else where it redirects. */
export function clientHost(client: {
  id: string;
  registration: string;
  redirectUris: string[];
}) {
  const address =
    client.registration === "metadata_document"
      ? client.id
      : client.redirectUris[0];

  if (!address) return null;

  try {
    return new URL(address).host;
  } catch {
    return null;
  }
}

/** The MCP server's canonical resource URI (RFC 8707). */
export function mcpResourceUri(origin: string) {
  return `${origin}/mcp`;
}

/** The JMAP API's resource URI (RFC 8707). */
export function jmapResourceUri(origin: string) {
  return `${origin}/jmap`;
}

/** RFC 9728 metadata location for the JMAP endpoints served at `origin`. */
export function jmapProtectedResourceMetadataUrl(origin: string) {
  return `${origin}/.well-known/oauth-protected-resource/jmap`;
}

/** The mail scopes the installed modules define; JMAP serves those. */
export function mailScopeIds() {
  return scopeDefinitions()
    .filter((scope) => scope.group === "mail")
    .map((scope) => scope.id);
}

/** OAuth 2.0 Protected Resource Metadata for JMAP. */
export function jmapProtectedResourceMetadata(
  env: AppEnv["Bindings"],
  origin: string
) {
  return {
    resource: jmapResourceUri(origin),
    authorization_servers: [oidcIssuer(env)],
    scopes_supported: [...mailScopeIds(), "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "OpenWorkspace mail (JMAP)",
  };
}

/** RFC 9728 metadata location for the MCP endpoint served at `origin`. */
export function protectedResourceMetadataUrl(origin: string) {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

/**
 * OAuth 2.0 Protected Resource Metadata for the MCP endpoint: clients learn
 * the authorization server and the scopes there are from here.
 */
export function protectedResourceMetadata(
  env: AppEnv["Bindings"],
  origin: string
) {
  return {
    resource: mcpResourceUri(origin),
    authorization_servers: [oidcIssuer(env)],
    scopes_supported: [...workspaceScopeIds(), "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "OpenWorkspace",
  };
}

/**
 * What a self-registered client (an MCP client) may ask for: workspace
 * scopes and refresh tokens, no identity scopes. It gets exactly what it
 * asks for, or `defaultSelfRegisteredScopes()` when it asks for nothing.
 */
export function selfRegisteredScopes(requested: readonly string[]) {
  const unique = [...new Set(requested)];
  const allowed = new Set([...workspaceScopeIds(), "offline_access"]);

  if (!unique.length) return defaultSelfRegisteredScopes();
  const unknown = unique.filter((scope) => !allowed.has(scope));

  if (unknown.length) {
    throw new OidcError(
      "invalid_scope",
      `This app may not request: ${unknown.join(" ")}`
    );
  }

  return unique;
}

/**
 * RFC 8707: the resource a token is for, this server's MCP endpoint or its
 * JMAP API, at one of `origins`. Without one, a request for workspace
 * scopes gets the resource a client of its kind uses: the MCP endpoint for
 * a self-registered (MCP) client, JMAP for an administrator-added mail app.
 * A request for identity scopes alone is for no resource. Null means none.
 */
export function resolveResource(
  client: Pick<OidcClient, "registration" | "allowedScopes">,
  scopes: readonly string[],
  resource: string | null,
  origins: readonly string[]
) {
  const reachesWorkspace =
    isSelfRegisteredClient(client) ||
    client.allowedScopes.some(isPrivilegedScope);

  if (resource === null) {
    if (!scopes.some(isPrivilegedScope)) return null;

    const origin = required(origins[0], "The workspace has an origin");

    return isSelfRegisteredClient(client)
      ? mcpResourceUri(origin)
      : jmapResourceUri(origin);
  }

  if (!reachesWorkspace) {
    throw new OidcError(
      "invalid_target",
      "This client cannot request a resource"
    );
  }

  return parseResource(resource, origins);
}

/** A `resource` parameter naming this server's MCP endpoint or JMAP API, normalized. */
export function parseResource(resource: string, origins: readonly string[]) {
  let url: URL;

  try {
    url = new URL(resource);
  } catch {
    throw new OidcError("invalid_target", "resource must be an absolute URI");
  }

  const path = url.pathname.replace(/\/$/u, "");

  if (
    url.hash ||
    url.search ||
    (path !== "/mcp" && path !== "/jmap") ||
    !origins.includes(url.origin)
  ) {
    throw new OidcError(
      "invalid_target",
      "resource must be this server's MCP or JMAP endpoint"
    );
  }

  return `${url.origin}${path}`;
}

/** The settings row for "Allow apps to register themselves"; on unless an administrator turned it off. */
const SELF_REGISTRATION_KEY = "allow_client_registration";

export async function selfRegistrationAllowed(db: Database) {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SELF_REGISTRATION_KEY))
    .limit(1);

  return row?.value !== "false";
}

export async function setSelfRegistrationAllowed(
  db: Database,
  allowed: boolean
) {
  const now = new Date();
  await db
    .insert(settings)
    .values({
      key: SELF_REGISTRATION_KEY,
      value: String(allowed),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: String(allowed), updatedAt: now },
    });
}

/**
 * With self-registration off, apps that register themselves (RFC 7591) or
 * name a metadata document are refused at registration and authorization.
 * Tokens they already hold keep working until revoked.
 */
export async function assertSelfRegistrationAllowed(db: Database) {
  if (!(await selfRegistrationAllowed(db))) {
    throw new OidcError(
      "access_denied",
      "This workspace does not accept apps that register themselves",
      403
    );
  }
}

/** Self-registered clients are attributed to the workspace's first administrator. */
async function registrationOwner(db: Database) {
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active")))
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (!owner) {
    throw new OidcError(
      "temporarily_unavailable",
      "The workspace has no administrator yet",
      503
    );
  }

  return owner.id;
}

const redirectUrisSchema = z
  .array(
    z
      .string()
      .max(2048)
      .refine(
        isAllowedOidcRedirectUri,
        "redirect_uris must use HTTPS or HTTP on a loopback address"
      )
  )
  .nonempty()
  .max(MAX_REDIRECT_URIS);

const clientNameSchema = z.string().trim().min(1).max(MAX_CLIENT_NAME);

const registrationSchema = z.object({
  redirect_uris: redirectUrisSchema,
  client_name: clientNameSchema.optional(),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .default(["authorization_code", "refresh_token"]),
  response_types: z.array(z.literal("code")).default(["code"]),
  scope: z.string().max(200).optional(),
});

function clientMetadataError(error: z.ZodError) {
  const issue = error.issues[0];
  const field = issue?.path.join(".") || "metadata";

  return new OidcError(
    "invalid_client_metadata",
    `${field}: ${issue?.message ?? "invalid"}`
  );
}

/** RFC 7591 dynamic registration, for MCP clients that do not publish a metadata document. */
export async function registerDynamicClient(db: Database, body: string) {
  let json: unknown;

  try {
    json = JSON.parse(body);
  } catch {
    throw new OidcError(
      "invalid_client_metadata",
      "The registration body must be JSON"
    );
  }

  await assertSelfRegistrationAllowed(db);
  const parsed = registrationSchema.safeParse(json);

  if (!parsed.success) throw clientMetadataError(parsed.error);
  const input = parsed.data;
  let scopes: string[];

  try {
    scopes = selfRegisteredScopes(
      (input.scope ?? "").split(/\s+/u).filter(Boolean)
    );
  } catch (error) {
    throw new OidcError(
      "invalid_client_metadata",
      error instanceof Error ? error.message : "scope is not allowed"
    );
  }

  const id = createId("mcpc");
  const now = new Date();
  const name = input.client_name ?? new URL(input.redirect_uris[0]).hostname;
  await db.insert(oidcClients).values({
    id,
    name,
    clientType: "public",
    redirectUris: input.redirect_uris,
    // What it registered for; each authorization still asks for its own.
    allowedScopes: scopes,
    trusted: false,
    enabled: true,
    registration: "dynamic",
    createdByUserId: await registrationOwner(db),
    createdAt: now,
    updatedAt: now,
  });

  return {
    client_id: id,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: name,
    redirect_uris: input.redirect_uris,
    grant_types: input.grant_types,
    response_types: input.response_types,
    token_endpoint_auth_method: "none" as const,
    scope: scopes.join(" "),
  };
}

/**
 * Client ID Metadata Documents: an HTTPS URL with a path is itself the
 * client ID, and the JSON it serves describes the client. Only on the
 * default port of a named host: an IP address or another port would let a
 * client ID make this server probe arbitrary services.
 */
export function isMetadataDocumentClientId(clientId: string) {
  try {
    const url = new URL(clientId);

    return (
      url.protocol === "https:" &&
      url.port === "" &&
      !isIpLiteral(url.hostname) &&
      url.pathname !== "/" &&
      !url.hash &&
      !url.username &&
      !url.password &&
      clientId.length <= 512
    );
  } catch {
    return false;
  }
}

/** A host the URL parser left as an address: dotted IPv4 (it normalizes other forms to it) or bracketed IPv6. */
function isIpLiteral(hostname: string) {
  return hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/u.test(hostname);
}

/** The body, read until `maxBytes`; a longer one is cut off and refused. */
async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
) {
  const { bytes, complete } = await readBounded(body, maxBytes);

  if (!complete) {
    throw new OidcError(
      "invalid_client",
      "The client metadata document is too large",
      401
    );
  }

  return new TextDecoder().decode(bytes);
}

const metadataDocumentSchema = z.object({
  client_id: z.string(),
  client_name: clientNameSchema.optional(),
  redirect_uris: redirectUrisSchema,
  token_endpoint_auth_method: z.literal("none").optional(),
});

async function fetchMetadataDocument(clientId: string) {
  let response: Response;

  try {
    response = await fetch(clientId, {
      headers: { accept: "application/json" },
      // Workers have no "error" mode; a redirect fails the status check below.
      redirect: "manual",
      signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new OidcError(
      "invalid_client",
      "The client metadata document could not be fetched",
      401
    );
  }

  if (!response.ok) {
    await response.body?.cancel();
    // Nothing about the other server's answer goes back to whoever named it.
    throw new OidcError(
      "invalid_client",
      "The client metadata document could not be fetched",
      401
    );
  }

  const declared = Number(response.headers.get("content-length") ?? 0);

  if (declared > METADATA_DOCUMENT_MAX_BYTES) {
    await response.body?.cancel();
    throw new OidcError(
      "invalid_client",
      "The client metadata document is too large",
      401
    );
  }

  // Counted in bytes as they arrive, whatever the length header said.
  const text = await readLimited(response.body, METADATA_DOCUMENT_MAX_BYTES);
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    throw new OidcError(
      "invalid_client",
      "The client metadata document is not JSON",
      401
    );
  }

  const parsed = metadataDocumentSchema.safeParse(json);

  if (!parsed.success) {
    const error = clientMetadataError(parsed.error);
    throw new OidcError(
      "invalid_client",
      `Client metadata document: ${error.message}`,
      401
    );
  }

  if (parsed.data.client_id !== clientId) {
    throw new OidcError(
      "invalid_client",
      "The client metadata document names a different client_id",
      401
    );
  }

  return parsed.data;
}

async function resolveMetadataDocumentClient(db: Database, clientId: string) {
  const [cached] = await db
    .select()
    .from(oidcClients)
    .where(eq(oidcClients.id, clientId))
    .limit(1);

  if (cached && cached.registration !== "metadata_document") {
    throw new OidcError("invalid_client", "Unknown OIDC client", 401);
  }

  if (cached && !cached.enabled) {
    throw new OidcError(
      "access_denied",
      "An administrator turned this app off for the workspace",
      403
    );
  }

  const age = cached?.metadataFetchedAt
    ? Date.now() - cached.metadataFetchedAt.getTime()
    : Infinity;

  if (cached && age < METADATA_DOCUMENT_TTL_MS) return cached;

  let document: Awaited<ReturnType<typeof fetchMetadataDocument>>;

  try {
    document = await fetchMetadataDocument(clientId);
  } catch (error) {
    if (cached && age < METADATA_DOCUMENT_STALE_MS) return cached;
    throw error;
  }

  const now = new Date();

  const values = {
    name: document.client_name ?? new URL(clientId).hostname,
    redirectUris: document.redirect_uris,
    metadataFetchedAt: now,
    updatedAt: now,
  };

  if (cached) {
    await db
      .update(oidcClients)
      .set(values)
      .where(eq(oidcClients.id, clientId));

    return { ...cached, ...values };
  }

  await db
    .insert(oidcClients)
    .values({
      id: clientId,
      ...values,
      clientType: "public",
      allowedScopes: defaultSelfRegisteredScopes(),
      trusted: false,
      enabled: true,
      registration: "metadata_document",
      createdByUserId: await registrationOwner(db),
      createdAt: now,
    })
    .onConflictDoNothing();

  return findEnabledClient(db, clientId);
}

/** Looks up a client, fetching and caching it first when its ID is a metadata document URL. */
export function resolveClient(db: Database, clientId: string) {
  return isMetadataDocumentClientId(clientId)
    ? resolveMetadataDocumentClient(db, clientId)
    : findEnabledClient(db, clientId);
}

export type OAuthIdentity = {
  user: SessionUser;
  clientId: string;
  familyId: string;
  tokenHash: string;
  /** The token's scopes that the person may still use (oidc/scopes.ts), checked now. */
  scopes: string[];
};

/**
 * An OAuth access token for one of `resources` (RFC 8707: the MCP endpoint,
 * or JMAP): unexpired, from an enabled client the person may still use, for
 * an active person. Its scopes come back narrowed to what the person may do
 * today, so a lost permission is lost to their apps at once.
 */
export async function authenticateAccessToken(
  db: Database,
  rawToken: string,
  resources: readonly string[]
): Promise<OAuthIdentity | null> {
  if (rawToken.length > 200) return null;
  const tokenHash = await hashToken(rawToken);

  const [token] = await db
    .select({
      clientId: oidcAccessTokens.clientId,
      familyId: oidcAccessTokens.familyId,
      scopes: oidcAccessTokens.scopes,
      resource: oidcAccessTokens.resource,
      id: users.id,
      name: users.name,
      avatarId: users.avatarId,
      role: users.role,
      status: users.status,
      permissions: users.permissions,
    })
    .from(oidcAccessTokens)
    .innerJoin(users, eq(oidcAccessTokens.userId, users.id))
    .where(
      and(
        eq(oidcAccessTokens.tokenHash, tokenHash),
        gt(oidcAccessTokens.expiresAt, new Date()),
        eq(users.status, "active")
      )
    )
    .limit(1);

  if (!token?.resource || !resources.includes(token.resource)) return null;

  try {
    const client = await findEnabledClient(db, token.clientId);
    await assertUserCanUseClient(db, client, token.id);
  } catch {
    return null;
  }

  const { clientId, familyId, scopes, resource: _resource, ...user } = token;

  return {
    user,
    clientId,
    familyId,
    tokenHash,
    scopes: coveredScopes(user, scopes),
  };
}
