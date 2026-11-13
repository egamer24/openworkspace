import type { ApiErrorCode } from "../lib/http";

export class AuthRequestError extends Error {
  readonly status: 400 | 409;
  readonly code: Extract<ApiErrorCode, "CONFLICT" | "WEBAUTHN_FAILED">;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      status?: 400 | 409;
      code?: Extract<ApiErrorCode, "CONFLICT" | "WEBAUTHN_FAILED">;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "AuthRequestError";
    this.status = options.status ?? 400;
    this.code = options.code ?? "WEBAUTHN_FAILED";
  }
}

export function authConflict(message: string) {
  return new AuthRequestError(message, {
    status: 409,
    code: "CONFLICT",
  });
}
