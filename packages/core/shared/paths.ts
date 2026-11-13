/**
 * Where core's Worker routes live (worker/workspace.ts mounts them), and the
 * paths `OpenWorkspace` therefore runs on the Worker before static assets.
 */
export const CORE_PATHS = {
  api: "/api",
  mcp: "/mcp",
  wellKnown: "/.well-known",
  oauth: "/oauth",
  saml: "/saml",
  /** Named after the workspace, with its logo as the icon. */
  webManifest: "/manifest.webmanifest",
} as const;

/** The browser app's SAML sign-in screen, inside the Worker's /saml prefix. */
export const SAML_LOGIN_PAGE = `${CORE_PATHS.saml}/login`;

/** A route prefix and everything under it, as `run_worker_first` patterns. */
export function workerFirstPatterns(prefix: string) {
  return [prefix, `${prefix}/*`];
}

/** Core's `run_worker_first` patterns: its prefixes, but not the SAML sign-in screen. */
export const coreWorkerFirst = [
  ...workerFirstPatterns(CORE_PATHS.api),
  ...workerFirstPatterns(CORE_PATHS.mcp),
  ...workerFirstPatterns(CORE_PATHS.wellKnown),
  ...workerFirstPatterns(CORE_PATHS.oauth),
  `!${SAML_LOGIN_PAGE}/*`,
  ...workerFirstPatterns(CORE_PATHS.saml),
  CORE_PATHS.webManifest,
];
