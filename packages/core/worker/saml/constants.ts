/**
 * The identity provider's endpoints, relative to its origin (saml/routes.ts
 * mounts them). The metadata URL is also the IdP's entity ID.
 */
export const SAML_PATHS = {
  metadata: "/saml/metadata",
  sso: "/saml/sso",
} as const;

export const SAML_CLOCK_SKEW_MS = 10 * 60 * 1000;
export const SAML_REQUEST_TTL_MS = 10 * 60 * 1000;

export function samlReplayCleanupBefore(now: Date) {
  return new Date(now.getTime() - SAML_CLOCK_SKEW_MS);
}

/** The largest service provider metadata document read. */
export const SP_METADATA_MAX_BYTES = 512 * 1024;
