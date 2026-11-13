import type { Context } from "hono";

import { identityProviderOrigin } from "./identity-provider-origin";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "NOT_READY"
  | "UNAUTHORIZED"
  | "WEBAUTHN_FAILED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "BAD_GATEWAY"
  | "UPGRADE_REQUIRED"
  | "TOO_LARGE"
  | "UNPROCESSABLE"
  | "UNAVAILABLE";

export function apiError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 426 | 429 | 502 | 503,
  code: ApiErrorCode,
  message: string
) {
  return c.json({ ok: false as const, error: { code, message } }, status);
}

/** The bindings that name the app's origin (`OpenWorkspace({ hostname })`). */
export type RelyingPartyEnv = Parameters<typeof identityProviderOrigin>[0];

/**
 * The passkeys' relying party: the app's configured origin and its host,
 * whatever host the request came in on, so a passkey is only ever made for
 * and used on the workspace's hostname.
 */
export function getRelyingParty(env: RelyingPartyEnv) {
  const origin = identityProviderOrigin(env);

  return { origin, rpId: new URL(origin).hostname };
}
