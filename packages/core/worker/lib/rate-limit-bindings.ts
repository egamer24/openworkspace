/**
 * The workspace's Workers Rate Limiting bindings, the one list of them:
 * `OpenWorkspace` creates each with its namespace id, and the Worker's `Env`
 * types them. A binding allows `limit` requests per key per
 * `RATE_LIMIT_PERIOD_SECONDS`. Call sites key their own counters
 * (lib/rate-limit.ts), so core and modules share these bindings without
 * sharing counts; a module that needs another limit adds it here.
 *
 * Cloudflare identifies a limit by its namespace id, which must stay the
 * same for the binding, and is unique per account: keys carry the
 * workspace's host, so workspaces in one account share the namespaces.
 */
export const rateLimitBindings = {
  RATE_LIMIT_10: { limit: 10, namespaceId: 7310 },
  RATE_LIMIT_20: { limit: 20, namespaceId: 7311 },
  RATE_LIMIT_30: { limit: 30, namespaceId: 7312 },
  RATE_LIMIT_60: { limit: 60, namespaceId: 7313 },
  RATE_LIMIT_120: { limit: 120, namespaceId: 7314 },
} as const satisfies Record<string, { limit: number; namespaceId: number }>;

export type RateLimitBinding = keyof typeof rateLimitBindings;

/** Every limit counts over this window, so a refused request may retry after it. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;
