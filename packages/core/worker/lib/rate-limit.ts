import type { Context } from "hono";

import type { AppEnv } from "../env";
import { apiError } from "./http";
import { RATE_LIMIT_PERIOD_SECONDS } from "./rate-limit-bindings";
import type { RateLimitBinding } from "./rate-limit-bindings";
import { cloudflareClientIp } from "./request";

export {
  RATE_LIMIT_PERIOD_SECONDS,
  type RateLimitBinding,
} from "./rate-limit-bindings";

/**
 * Counts one request under `action` and `key` (a person's id, or
 * `clientAddress`) in `binding` (lib/rate-limit-bindings.ts) and says
 * whether it is within the limit. Each call site names its own `action`, so
 * sites with the same limit share a binding without sharing counts. The
 * workspace's host is part of the key: workspaces in one Cloudflare account
 * share the bindings' namespaces. Counting is per Cloudflare location and
 * approximate, which suits throttling.
 */
export async function withinRateLimit<E extends AppEnv>(
  c: Context<E>,
  binding: RateLimitBinding,
  action: string,
  key: string
) {
  const { success } = await c.env[binding].limit({
    key: `${new URL(c.req.url).host}:${action}:${key}`,
  });

  return success;
}

/** `withinRateLimit`'s opposite, with `retry-after` set on the response when over. */
export async function overRateLimit<E extends AppEnv>(
  c: Context<E>,
  binding: RateLimitBinding,
  action: string,
  key: string
) {
  if (await withinRateLimit(c, binding, action, key)) return false;
  c.header("retry-after", String(RATE_LIMIT_PERIOD_SECONDS));

  return true;
}

/** The API's answer to a request over its limit. */
export function rateLimitedResponse(c: Context<AppEnv>, message: string) {
  c.header("retry-after", String(RATE_LIMIT_PERIOD_SECONDS));

  return apiError(c, 429, "RATE_LIMITED", message);
}

/**
 * Who a per-address limit counts: the address Cloudflare saw (never a
 * forwarded header, which the client writes), with an IPv6 address
 * reduced to its /64, which one subscriber usually holds whole.
 */
export function clientAddress(request: Request) {
  const ip = cloudflareClientIp(request);

  if (!ip) return "unknown";

  return ip.includes(":") ? (ipv6Prefix64(ip) ?? ip) : ip;
}

/** The /64 network of an IPv6 address, as `xxxx:xxxx:xxxx:xxxx::/64`; null if it isn't one. */
export function ipv6Prefix64(address: string) {
  // An address's zone (fe80::1%eth0) is not part of it.
  const [value = ""] = address
    .replaceAll(/^\[|\]$/gu, "")
    .toLowerCase()
    .split("%");

  // An IPv4 tail (::ffff:192.0.2.1) is in the last 32 bits, past the prefix.
  const withoutIpv4 = value.replace(/:(\d+\.\d+\.\d+\.\d+)$/u, ":0:0");
  const halves = withoutIpv4.split("::");

  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;

  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const groups = [
    ...head,
    ...Array.from({ length: missing }, () => "0"),
    ...tail,
  ];

  if (!groups.every((group) => /^[0-9a-f]{1,4}$/u.test(group))) return null;

  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/u, ""))
    .join(":")}::/64`;
}
