import { z } from "zod";

import type { InboundAuthentication } from "../../shared/mail-authentication";
import { ipKind, normalizeIp } from "../../shared/mail-received";
import type {
  BimiResult,
  LookupStatus,
  SenderIntel,
  SpamhausResult,
} from "../../shared/mail-sender-intel";
import { resolveBimi } from "./bimi";
import { createDohResolver } from "./doh";
import type { DnsResolver } from "./doh";
import { heloMatchesPtr, ipIntelCacheTtl, lookupIpIntel } from "./ip-intel";
import type { IpIntel } from "./ip-intel";
import { MAX_LINK_DOMAINS } from "./link-domains";
import { isWorkspaceDomain } from "./message-security";
import { organizationalDomain } from "./org-domain";
import { checkSpamhaus } from "./spamhaus";

const LookupStatusSchema = z.enum([
  "ok",
  "nxdomain",
  "timeout",
  "error",
  "skipped",
]) satisfies z.ZodType<LookupStatus>;

const IpIntelSchema = z.object({
  ptr: z.object({
    status: LookupStatusSchema,
    names: z.array(z.string()),
    confirmed: z.string().nullable(),
    fcrdns: z.boolean().nullable(),
    generic: z.boolean().nullable(),
  }),
  network: z.object({
    status: LookupStatusSchema,
    asn: z.number().nullable(),
    asName: z.string().nullable(),
    prefix: z.string().nullable(),
    country: z.string().nullable(),
    registry: z.string().nullable(),
  }),
}) satisfies z.ZodType<IpIntel>;

const SpamhausCheckSchema = z.object({
  status: LookupStatusSchema,
  listings: z.array(
    z.object({
      zone: z.enum(["zen", "dbl"]),
      target: z.string(),
      code: z.string(),
      list: z.string(),
      severity: z.enum(["abuse", "policy"]),
    })
  ),
  error: z.string().nullable(),
});

/** A stored `sender_intel_json` column (version 1). */
const SenderIntelSchema = IpIntelSchema.extend({
  version: z.literal(1),
  source: z.enum(["live", "demo"]),
  checkedAt: z.number(),
  ip: z.string().nullable(),
  ipVersion: z.union([z.literal(4), z.literal(6)]).nullable(),
  heloMatchesPtr: z.boolean().nullable(),
  spamhaus: z
    .object({
      zen: SpamhausCheckSchema,
      dbl: SpamhausCheckSchema.extend({ domains: z.array(z.string()) }),
    })
    .nullable(),
  bimi: z
    .object({
      domain: z.string(),
      status: z.enum(["ok", "none", "invalid", "error"]),
      reason: z.string().nullable(),
    })
    .nullable(),
}) satisfies z.ZodType<SenderIntel>;

export const SENDER_INTEL_BUDGET_MS = 1500;
const MEMORY_CACHE_LIMIT = 500;
const CACHE_ORIGIN = "https://sender-intel.openworkspace.invalid";

export type IntelCache = {
  get(ip: string): Promise<IpIntel | null>;
  put(ip: string, intel: IpIntel, ttlSeconds: number): Promise<void>;
};

const memory = new Map<string, { intel: IpIntel; expiresAt: number }>();

/**
 * Isolate memory first, then the colo-local Cache API under a synthetic URL.
 * Both are best effort: a failing cache never fails ingestion.
 */
export function defaultIntelCache(): IntelCache {
  const request = (ip: string) =>
    new Request(`${CACHE_ORIGIN}/ip/v1/${encodeURIComponent(ip)}`);

  const open = async () => {
    try {
      return await caches.open("openworkspace:sender-intel");
    } catch {
      return null;
    }
  };

  return {
    async get(ip) {
      const hit = memory.get(ip);

      if (hit && hit.expiresAt > Date.now()) return hit.intel;

      try {
        const response = await (await open())?.match(request(ip));

        if (!response) return null;
        const cached = IpIntelSchema.safeParse(await response.json());

        return cached.success ? cached.data : null;
      } catch {
        return null;
      }
    },
    async put(ip, intel, ttlSeconds) {
      if (memory.size >= MEMORY_CACHE_LIMIT) {
        const oldest = memory.keys().next();

        if (!oldest.done) memory.delete(oldest.value);
      }

      memory.set(ip, { intel, expiresAt: Date.now() + ttlSeconds * 1000 });

      try {
        await (
          await open()
        )?.put(
          request(ip),
          Response.json(intel, {
            headers: { "cache-control": `max-age=${ttlSeconds}` },
          })
        );
      } catch {
        // Best effort only.
      }
    },
  };
}

function skippedIpIntel(status: LookupStatus): IpIntel {
  return {
    ptr: { status, names: [], confirmed: null, fcrdns: null, generic: null },
    network: {
      status,
      asn: null,
      asName: null,
      prefix: null,
      country: null,
      registry: null,
    },
  };
}

/** Resolves to `fallback` once the deadline passes, even if the work ignores the abort signal. */
function withDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
  fallback: () => T
): Promise<T> {
  return new Promise((resolve) => {
    const onAbort = () => resolve(fallback());

    if (signal.aborted) {
      onAbort();

      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    // oxlint-disable-next-line promise/catch-or-return -- then()'s second argument handles rejection
    work
      .then(resolve, () => resolve(fallback()))
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** BIMI applies only when DMARC passed under p=quarantine or p=reject. */
export function bimiEligible(authentication: InboundAuthentication | null) {
  const dmarc = authentication?.dmarc;

  return Boolean(
    authentication?.fromDomain &&
    dmarc?.result === "pass" &&
    (dmarc.policy === "quarantine" || dmarc.policy === "reject")
  );
}

/**
 * Sending-server intelligence for one message: PTR + FCrDNS and Team Cymru
 * ASN data for the trusted remote IP, Spamhaus ZEN/DBL when a DQS key is
 * configured, and the BIMI logo. All lookups run in parallel under one
 * budget and fail open with a per-field status.
 */
export async function collectSenderIntel(input: {
  authentication: InboundAuthentication | null;
  fromAddress: string;
  linkDomains: string[];
  workspaceDomains: readonly string[];
  dqsKey: string | null;
  bucket: R2Bucket;
  fetch?: typeof fetch;
  resolver?: DnsResolver;
  cache?: IntelCache;
  budgetMs?: number;
  now?: number;
}): Promise<SenderIntel> {
  const now = input.now ?? Date.now();
  const signal = AbortSignal.timeout(input.budgetMs ?? SENDER_INTEL_BUDGET_MS);

  const resolve =
    input.resolver ?? createDohResolver({ fetch: input.fetch, signal });

  const cache = input.cache ?? defaultIntelCache();
  const auth = input.authentication;
  const ip = normalizeIp(auth?.remoteIp);
  const publicIp = ip && ipKind(ip) === "public" ? ip : null;

  const ipWork = publicIp
    ? withDeadline(
        (async () => {
          const cached = await cache.get(publicIp);

          if (cached) return cached;
          const fresh = await lookupIpIntel(resolve, publicIp);
          const ttl = ipIntelCacheTtl(fresh);

          if (ttl > 0) await cache.put(publicIp, fresh, ttl);

          return fresh;
        })(),
        signal,
        () => skippedIpIntel("timeout")
      )
    : Promise.resolve(skippedIpIntel("skipped"));

  const fromOrg = organizationalDomain(input.fromAddress);

  const dblDomains = [...new Set([fromOrg, ...input.linkDomains])]
    .filter(
      (domain): domain is string =>
        Boolean(domain) && !isWorkspaceDomain(domain, input.workspaceDomains)
    )
    .slice(0, MAX_LINK_DOMAINS);

  const spamhausWork: Promise<SpamhausResult | null> = input.dqsKey
    ? withDeadline(
        checkSpamhaus({
          resolve,
          key: input.dqsKey,
          ip: publicIp,
          domains: dblDomains,
        }),
        signal,
        () => ({
          zen: { status: "timeout", listings: [], error: null },
          dbl: {
            status: "timeout",
            listings: [],
            error: null,
            domains: dblDomains,
          },
        })
      )
    : Promise.resolve(null);

  const fromDomain = auth?.fromDomain ?? null;

  const bimiWork: Promise<BimiResult | null> =
    bimiEligible(auth) && fromDomain
      ? withDeadline(
          resolveBimi({
            resolve,
            fetch: input.fetch,
            bucket: input.bucket,
            fromDomain,
            orgDomain: organizationalDomain(fromDomain),
            signal,
            now,
          }),
          signal,
          () => ({
            domain: fromDomain,
            status: "error",
            reason: "The BIMI lookup timed out",
          })
        )
      : Promise.resolve(null);

  const [ipIntel, spamhaus, bimi] = await Promise.all([
    ipWork,
    spamhausWork,
    bimiWork,
  ]);

  return {
    version: 1,
    source: "live",
    checkedAt: now,
    ip,
    ipVersion: ip ? (ip.includes(":") ? 6 : 4) : null,
    ...ipIntel,
    heloMatchesPtr: heloMatchesPtr(auth?.helo ?? null, ipIntel.ptr),
    spamhaus,
    bimi,
  };
}

/** Lazy fills skip persisting a result where every attempted lookup failed. */
export function senderIntelWorthStoring(intel: SenderIntel) {
  const statuses: LookupStatus[] = [intel.ptr.status, intel.network.status];

  if (intel.spamhaus) {
    statuses.push(intel.spamhaus.zen.status, intel.spamhaus.dbl.status);
  }

  const attempted = statuses.filter((status) => status !== "skipped");

  return (
    !attempted.length ||
    attempted.some((status) => status === "ok" || status === "nxdomain")
  );
}

/** A message's stored sender intelligence, or null when absent or of another version. */
export function storedSenderIntel(
  value: SenderIntel | null | undefined
): SenderIntel | null {
  const parsed = SenderIntelSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}
