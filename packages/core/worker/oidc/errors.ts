export type OidcErrorCode =
  | "access_denied"
  | "consent_required"
  | "interaction_required"
  | "invalid_client"
  | "invalid_client_metadata"
  | "invalid_grant"
  | "invalid_request"
  | "invalid_scope"
  | "invalid_target"
  | "invalid_token"
  | "login_required"
  | "server_error"
  | "temporarily_unavailable"
  | "unsupported_grant_type"
  | "unsupported_response_type";

export class OidcError extends Error {
  constructor(
    readonly code: OidcErrorCode,
    message: string,
    readonly status: 400 | 401 | 403 | 429 | 500 | 503 = 400
  ) {
    super(message);
    this.name = "OidcError";
  }
}

export function oidcError(cause: unknown) {
  if (cause instanceof OidcError) return cause;
  console.error(cause);

  return new OidcError("server_error", "The authorization server failed", 500);
}
