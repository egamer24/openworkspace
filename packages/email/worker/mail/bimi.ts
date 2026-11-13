import { z } from "zod";

import type { BimiResult, BimiStatus } from "../../shared/mail-sender-intel";
import { readCappedBody } from "./capped-body";
import { isAbortError } from "./doh";
import type { DnsResolver } from "./doh";
import { assertProxyableRemoteUrl } from "./remote-proxy";

/**
 * BIMI logo lookup without VMC/CMC validation: we show the domain's own logo
 * only after DMARC passed under an enforcing policy, but never a checkmark.
 * https://datatracker.ietf.org/doc/draft-brand-indicators-for-message-identification/
 */

export const MAX_BIMI_SVG_BYTES = 32 * 1024;
const BIMI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BIMI_ERROR_TTL_MS = 60 * 60 * 1000;

export function bimiObjectKey(domain: string) {
  return `bimi/v1/${domain}.svg`;
}

export function bimiLogoPath(domain: string) {
  return `/api/mail/bimi/${encodeURIComponent(domain)}`;
}

/** Strict CSP for serving stored logos: no scripts, no external loads. */
export const BIMI_LOGO_HEADERS = {
  "content-type": "image/svg+xml",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "private, max-age=86400",
} as const;

/** `v=BIMI1; l=https://…/logo.svg; a=…` → the logo location, or null when declined. */
export function parseBimiRecord(value: string) {
  const tags = new Map<string, string>();

  for (const part of value.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) continue;
    tags.set(
      part.slice(0, index).trim().toLocaleLowerCase(),
      part.slice(index + 1).trim()
    );
  }

  if (tags.get("v") !== "BIMI1") return null;
  const location = tags.get("l")?.split(",")[0]?.trim() ?? "";

  return { location: location || null };
}

const FORBIDDEN_ELEMENTS =
  /<\s*(?:script|foreignobject|iframe|object|embed|image|a|animate\w*|set|audio|video|canvas|handler|listener|discard)\b/iu;

/**
 * Conservative SVG Tiny PS check. Rejects anything that could run code or load
 * another resource; returns the trimmed document, or a reason it was refused.
 */
export function validateBimiSvg(
  source: string
): { svg: string } | { error: string } {
  if (new TextEncoder().encode(source).byteLength > MAX_BIMI_SVG_BYTES) {
    return { error: "The logo is larger than 32 KB" };
  }

  const svg = source.replace(/^﻿/u, "").trim();

  const body = svg
    .replace(/^<\?xml[^>]*\?>\s*/iu, "")
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .trim();

  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/iu.test(body)) {
    return { error: "The logo declares a DTD, entity or CDATA section" };
  }

  if (!/^<svg[\s>]/iu.test(body) || !/<\/svg>\s*$/iu.test(body)) {
    return { error: "The file is not an SVG document" };
  }

  if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/u.test(body)) {
    return { error: "The SVG namespace is missing" };
  }

  if (FORBIDDEN_ELEMENTS.test(body)) {
    return { error: "The logo contains scripts, links, images or animation" };
  }

  if (/\son[a-z]+\s*=/iu.test(body)) {
    return { error: "The logo contains event handlers" };
  }

  if (/javascript:|data:|@import/iu.test(body)) {
    return { error: "The logo references executable or embedded content" };
  }

  for (const match of body.matchAll(
    /\b(?:xlink:)?href\s*=\s*["']([^"']*)["']/giu
  )) {
    if (!match[1].trim().startsWith("#")) {
      return { error: "The logo references an external resource" };
    }
  }

  for (const match of body.matchAll(/url\(\s*['"]?([^'")]*)/giu)) {
    if (!match[1].trim().startsWith("#")) {
      return { error: "The logo references an external resource" };
    }
  }

  return { svg };
}

async function readCapped(response: Response, limit: number) {
  if (!response.body) return null;
  const bytes = await readCappedBody(response.body, limit);

  return bytes && new TextDecoder().decode(bytes);
}

type Lookup = { status: BimiStatus; reason: string | null; svg?: string };

async function lookup(input: {
  resolve: DnsResolver;
  fetch: typeof fetch;
  domain: string;
  signal?: AbortSignal;
}): Promise<Lookup> {
  const answer = await input.resolve(`default._bimi.${input.domain}`, "TXT");

  if (answer.status === "timeout" || answer.status === "error") {
    return {
      status: "error",
      reason: "The BIMI record could not be looked up",
    };
  }

  const record = answer.records.map(parseBimiRecord).find(Boolean);

  if (!record) {
    return { status: "none", reason: "The domain publishes no BIMI record" };
  }

  if (!record.location) {
    return { status: "none", reason: "The domain declined to show a logo" };
  }

  let url: URL;

  try {
    url = assertProxyableRemoteUrl(record.location);
  } catch {
    return {
      status: "invalid",
      reason: "The BIMI logo location is not a valid public URL",
    };
  }

  if (url.protocol !== "https:") {
    return {
      status: "invalid",
      reason: "The BIMI logo is not served over HTTPS",
    };
  }

  try {
    const response = await input.fetch(url, {
      redirect: "manual",
      headers: { accept: "image/svg+xml" },
      signal: input.signal,
    });

    if (!response.ok) {
      return {
        status: "error",
        reason: `The logo server answered ${response.status}`,
      };
    }

    const declared = Number(response.headers.get("content-length") ?? 0);

    if (declared > MAX_BIMI_SVG_BYTES) {
      return { status: "invalid", reason: "The logo is larger than 32 KB" };
    }

    const text = await readCapped(response, MAX_BIMI_SVG_BYTES);

    if (text === null) {
      return { status: "invalid", reason: "The logo is larger than 32 KB" };
    }

    const checked = validateBimiSvg(text);

    if ("error" in checked) return { status: "invalid", reason: checked.error };

    return { status: "ok", reason: null, svg: checked.svg };
  } catch (error) {
    return {
      status: "error",
      reason: isAbortError(error)
        ? "The logo download timed out"
        : "The logo could not be downloaded",
    };
  }
}

const BIMI_STATUSES = ["ok", "none", "invalid", "error"] as const;

/** What resolveBimi stores beside each cached logo in R2. */
const CachedBimiMetadata = z.object({
  status: z.enum(BIMI_STATUSES) satisfies z.ZodType<BimiStatus>,
  checkedAt: z.coerce.number(),
  reason: z.string().optional(),
});

type BimiInput = {
  resolve: DnsResolver;
  fetch?: typeof fetch;
  bucket: R2Bucket;
  fromDomain: string;
  orgDomain: string | null;
  signal?: AbortSignal;
  now?: number;
};

/** One domain's logo: the cached outcome while fresh, else a new lookup that is cached. */
async function domainBimi(
  input: BimiInput,
  domain: string,
  now: number
): Promise<BimiResult> {
  const key = bimiObjectKey(domain);
  const cached = await input.bucket.head(key).catch(() => null);
  const metadata = CachedBimiMetadata.safeParse(cached?.customMetadata);

  if (metadata.success) {
    const { status, checkedAt, reason } = metadata.data;
    const ttl = status === "error" ? BIMI_ERROR_TTL_MS : BIMI_CACHE_TTL_MS;

    if (now - checkedAt < ttl) {
      return { domain, status, reason: reason || null };
    }
  }

  const result = await lookup({
    resolve: input.resolve,
    fetch: input.fetch ?? fetch,
    domain,
    signal: input.signal,
  });

  await input.bucket
    .put(key, result.svg ?? "", {
      httpMetadata: { contentType: "image/svg+xml" },
      customMetadata: {
        status: result.status,
        checkedAt: String(now),
        reason: result.reason ?? "",
      },
    })
    .catch(() => undefined);

  return { domain, status: result.status, reason: result.reason };
}

/**
 * Per-domain logo, cached in R2 for a day (an hour after a failure). The
 * From domain's record wins; the organizational domain is the fallback.
 */
export async function resolveBimi(input: BimiInput): Promise<BimiResult> {
  const now = input.now ?? Date.now();

  const [first, fallback] = [
    ...new Set(
      [input.fromDomain, input.orgDomain].filter((value): value is string =>
        Boolean(value)
      )
    ),
  ];

  if (!first) {
    return {
      domain: input.fromDomain,
      status: "none",
      reason: "The domain publishes no BIMI record",
    };
  }

  const primary = await domainBimi(input, first, now);

  if (primary.status !== "none" || !fallback) return primary;

  return domainBimi(input, fallback, now);
}
