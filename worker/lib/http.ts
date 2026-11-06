import type { Context } from "hono";

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
  | "UNAVAILABLE"
  | "QUOTA_EXCEEDED";

export function apiError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 426 | 429 | 502 | 503,
  code: ApiErrorCode,
  message: string,
) {
  return c.json({ ok: false as const, error: { code, message } }, status);
}

export function getRelyingParty(request: Request) {
  const url = new URL(request.url);
  return { origin: url.origin, rpId: url.hostname };
}
