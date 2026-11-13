import { authResults } from "../../shared/mail-authentication";
import type {
  ArcSealer,
  AuthResult,
  DkimResult,
  DmarcPolicy,
  InboundAuthentication,
  ListUnsubscribe,
  UpstreamAuthenticationClaim,
} from "../../shared/mail-authentication";
import {
  addressDomain,
  headerFields,
  scanComments,
  splitTopLevel,
  unquote,
} from "../../shared/mail-headers";
import type { HeaderField } from "../../shared/mail-headers";
import {
  isCloudflareHop,
  normalizeIp,
  parseReceived,
} from "../../shared/mail-received";
import { relaxedAligned } from "./org-domain";

export const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";
const CLOUDFLARE_ARC_DOMAIN = "cloudflare-email.net";
const MAX_TRUSTED_HEADER_LENGTH = 4096;

/** Cloudflare prepends 7 headers; the cap only matters when the score header is missing. */
const MAX_TRUSTED_BLOCK_WITHOUT_SCORE = 10;
const MAX_UPSTREAM_CLAIMS = 5;

/**
 * Sealers whose ARC results we accept to soften a DMARC failure on
 * forwarded or list mail, as Gmail and Microsoft do. Cloudflare validates the
 * chain itself; this list only decides how much the oldest results matter.
 */
const TRUSTED_ARC_SEALERS = new Set([
  "google.com",
  "microsoft.com",
  "outlook.com",
  "icloud.com",
  "yahoo.com",
  "messagingengine.com",
  "zoho.com",
  "protonmail.ch",
  "fastmail.com",
]);

// --- RFC 8601 Authentication-Results --------------------------------------

export type AuthResInfo = {
  method: string;
  result: string;
  reason: string | null;
  comments: string[];
  /** `ptype.property` (lowercased) to value. */
  props: Record<string, string>;
};

export type ParsedAuthenticationResults = {
  authservId: string;
  results: AuthResInfo[];
};

const VALUE = String.raw`"(?:[^"\\]|\\.)*"|[^\s;]+`;

function parseResInfo(segment: string): AuthResInfo | null {
  const { text, comments } = scanComments(segment);
  const method = /^\s*([a-z0-9_-]+)(?:\/\d+)?\s*=\s*([a-z0-9_-]+)/iu.exec(text);

  if (!method) return null;
  let rest = text.slice(method[0].length);
  let reason: string | null = null;

  const reasonMatch = new RegExp(
    String.raw`\breason\s*=\s*(${VALUE})`,
    "iu"
  ).exec(rest);

  if (reasonMatch) {
    reason = unquote(reasonMatch[1]);
    rest =
      rest.slice(0, reasonMatch.index) +
      rest.slice(reasonMatch.index + reasonMatch[0].length);
  }

  const props: Record<string, string> = {};

  for (const match of rest.matchAll(
    new RegExp(
      String.raw`([a-z0-9_-]+)\s*\.\s*([a-z0-9_-]+)\s*=\s*(${VALUE})`,
      "giu"
    )
  )) {
    const key = `${match[1]}.${match[2]}`.toLocaleLowerCase();
    props[key] ??= unquote(match[3]);
  }

  return {
    method: method[1].toLocaleLowerCase(),
    result: method[2].toLocaleLowerCase(),
    reason,
    comments,
    props,
  };
}

/** Parses an Authentication-Results value (RFC 8601 §2.2), comments and all. */
export function parseAuthenticationResults(
  value: string
): ParsedAuthenticationResults | null {
  const segments = splitTopLevel(value, ";");

  const authservId = scanComments(segments[0] ?? "")
    .text.trim()
    .split(/\s+/u)[0]
    ?.toLocaleLowerCase();

  if (!authservId) return null;

  return {
    authservId,
    results: segments.slice(1).flatMap((segment) => {
      const info = parseResInfo(segment);

      return info ? [info] : [];
    }),
  };
}

/** ARC-Authentication-Results carries `i=N;` before the A-R payload. */
export function parseArcAuthenticationResults(value: string) {
  const instance = /^\s*i\s*=\s*(\d+)\s*;/u.exec(value);

  if (!instance) return null;
  const parsed = parseAuthenticationResults(value.slice(instance[0].length));

  return parsed ? { instance: Number(instance[1]), ...parsed } : null;
}

// --- RFC 7208 Received-SPF -------------------------------------------------

export type ParsedReceivedSpf = {
  result: string;
  comment: string | null;
  pairs: Record<string, string>;
};

export function parseReceivedSpf(value: string): ParsedReceivedSpf | null {
  const result = /^\s*([a-z]+)/iu.exec(value);

  if (!result) return null;
  const { text, comments } = scanComments(value.slice(result[0].length));
  const pairs: Record<string, string> = {};

  for (const part of splitTopLevel(text, ";")) {
    const pair = new RegExp(
      String.raw`^\s*([a-z-]+)\s*=\s*(${VALUE})\s*$`,
      "iu"
    ).exec(part);

    if (pair) pairs[pair[1].toLocaleLowerCase()] ??= unquote(pair[2]);
  }

  return {
    result: result[1].toLocaleLowerCase(),
    comment: comments[0] ?? null,
    pairs,
  };
}

// --- Tag lists (DKIM-Signature, ARC-Seal) ----------------------------------

export function parseTagList(value: string) {
  const tags: Record<string, string> = {};

  for (const part of value.split(";")) {
    const equals = part.indexOf("=");

    if (equals < 1) continue;
    const name = part.slice(0, equals).trim().toLocaleLowerCase();

    if (!/^[a-z][a-z0-9_]*$/u.test(name) || name in tags) continue;
    tags[name] = part
      .slice(equals + 1)
      .replaceAll(/\s+/gu, name === "h" ? "" : " ")
      .trim();
  }

  return tags;
}

type DkimSignatureTags = {
  domain: string;
  selector: string | null;
  b: string;
  signedHeaders: string[];
};

function dkimSignatureTags(fields: HeaderField[]): DkimSignatureTags[] {
  return fields.flatMap((field) => {
    if (field.name !== "dkim-signature") return [];
    const tags = parseTagList(field.value);
    const domain = addressDomain(tags.d);

    if (!domain) return [];

    return [
      {
        domain,
        selector: tags.s?.trim() ?? null,
        b: (tags.b ?? "").replaceAll(/\s+/gu, ""),
        signedHeaders: (tags.h ?? "")
          .split(":")
          .map((name) => name.trim().toLocaleLowerCase())
          .filter(Boolean),
      },
    ];
  });
}

// --- Trusted block --------------------------------------------------------

/**
 * The run of headers Cloudflare prepended: from its Received line down to and
 * including X-CF-SpamH-Score. Everything below came from the sending side.
 */
export function trustedHeaderBlock(fields: HeaderField[]) {
  const first = fields[0];

  if (first?.name !== "received") return null;
  const hop = parseReceived(first.value);

  if (!isCloudflareHop(hop)) return null;

  const score = fields.findIndex((field) => field.name === "x-cf-spamh-score");

  if (score !== -1) {
    return {
      hop,
      trusted: fields.slice(0, score + 1),
      below: fields.slice(score + 1),
    };
  }

  const nextReceived = fields.findIndex(
    (field, index) => index > 0 && field.name === "received"
  );

  const end = Math.min(
    nextReceived === -1 ? fields.length : nextReceived,
    MAX_TRUSTED_BLOCK_WITHOUT_SCORE
  );

  return { hop, trusted: fields.slice(0, end), below: fields.slice(end) };
}

function authResult(value: string | null | undefined): AuthResult | null {
  return authResults.find((result) => result === value) ?? null;
}

function claimFrom(
  parsed: ParsedAuthenticationResults
): UpstreamAuthenticationClaim {
  const first = (method: string) =>
    authResult(
      parsed.results.find(
        (result) =>
          result.method === method &&
          (method !== "spf" || !result.props["smtp.helo"])
      )?.result
    );

  return {
    authservId: parsed.authservId,
    spf: first("spf"),
    dkim: first("dkim"),
    dmarc: first("dmarc"),
  };
}

function dmarcPolicy(value: string | undefined): DmarcPolicy | null {
  const normalized = value?.toLocaleLowerCase();

  return normalized === "none" ||
    normalized === "quarantine" ||
    normalized === "reject"
    ? normalized
    : null;
}

function matchSignature(
  result: AuthResInfo,
  domain: string,
  signatures: DkimSignatureTags[]
) {
  const bPrefix = result.props["header.b"]?.replaceAll(/\s+/gu, "");
  const selector = result.props["header.s"];

  const sameDomain = (signature: DkimSignatureTags) =>
    signature.domain === domain || domain.endsWith(`.${signature.domain}`);

  if (bPrefix) {
    const match = signatures.find(
      (signature) => sameDomain(signature) && signature.b.startsWith(bPrefix)
    );

    if (match) return match;
  }

  return (
    signatures.find(
      (signature) =>
        sameDomain(signature) && (!selector || signature.selector === selector)
    ) ?? null
  );
}

type Verdict = Pick<InboundAuthentication, "verdict" | "verdictReason">;

function verdictFor(
  input: Pick<InboundAuthentication, "spf" | "dkim" | "dmarc" | "arc">
): Verdict {
  const alignedDkimPass = input.dkim.some(
    (dkim) => dkim.result === "pass" && dkim.aligned
  );

  const alignedSpfPass = input.spf?.result === "pass" && input.spf.aligned;

  if (input.dmarc?.result === "pass") {
    return { verdict: "verified", verdictReason: "dmarc_pass" };
  }

  const failing =
    input.dmarc?.result === "fail"
      ? ("dmarc_fail" as const)
      : !alignedDkimPass && !alignedSpfPass
        ? ("no_aligned_pass" as const)
        : null;

  if (failing) {
    const { arc } = input;
    const oldestSealer = arc?.sealers[0]?.domain;

    if (
      arc?.result === "pass" &&
      arc.oldest?.dmarc === "pass" &&
      oldestSealer &&
      TRUSTED_ARC_SEALERS.has(oldestSealer)
    ) {
      return { verdict: "unverified", verdictReason: "forwarded_arc" };
    }

    return { verdict: "suspicious", verdictReason: failing };
  }

  if (alignedDkimPass && (!input.dmarc || input.dmarc.result === "none")) {
    return { verdict: "verified", verdictReason: "aligned_dkim" };
  }

  return { verdict: "unverified", verdictReason: "partial" };
}

function emptyAuthentication(
  now: number,
  fromDomain: string | null,
  reason: "not_cloudflare" | "missing_results",
  envelopeFrom: string | null
): InboundAuthentication {
  return {
    source: "headers",
    version: 1,
    authservId: null,
    parsedAt: now,
    remoteIp: null,
    helo: null,
    envelopeFrom,
    fromDomain,
    spf: null,
    spfHelo: null,
    dkim: [],
    dmarc: null,
    arc: null,
    spamScore: null,
    verdict: "unavailable",
    verdictReason: reason,
    upstream: [],
    ignoredCloudflareClaims: 0,
    trustedHeader: null,
  };
}

function claimsCloudflare(field: HeaderField) {
  if (field.name === "authentication-results") {
    return (
      parseAuthenticationResults(field.value)?.authservId ===
      CLOUDFLARE_AUTHSERV_ID
    );
  }

  if (field.name === "arc-authentication-results") {
    return (
      parseArcAuthenticationResults(field.value)?.authservId ===
      CLOUDFLARE_AUTHSERV_ID
    );
  }

  if (field.name === "received-spf") {
    return (
      parseReceivedSpf(field.value)?.pairs.receiver?.toLocaleLowerCase() ===
      CLOUDFLARE_AUTHSERV_ID
    );
  }

  if (field.name === "x-cf-spamh-score") return true;

  return false;
}

function arcSummary(
  trusted: HeaderField[],
  all: HeaderField[],
  arcResult: AuthResInfo | undefined
): InboundAuthentication["arc"] {
  const ownSeal = trusted.find(
    (field) =>
      field.name === "arc-seal" &&
      addressDomain(parseTagList(field.value).d) === CLOUDFLARE_ARC_DOMAIN
  );

  const ownInstance = Number(
    ownSeal ? parseTagList(ownSeal.value).i : Number.NaN
  );

  const result =
    arcResult?.result === "pass" || arcResult?.result === "fail"
      ? arcResult.result
      : "none";

  if (!arcResult && !ownSeal) return null;

  const chainLength =
    Number.isInteger(ownInstance) && ownInstance > 0 ? ownInstance : 1;

  const sealers = new Map<number, ArcSealer>();

  for (const field of all) {
    if (field.name !== "arc-seal") continue;
    const tags = parseTagList(field.value);
    const instance = Number(tags.i);

    if (
      !Number.isInteger(instance) ||
      instance < 1 ||
      instance >= chainLength ||
      sealers.has(instance)
    ) {
      continue;
    }

    sealers.set(instance, {
      instance,
      domain: addressDomain(tags.d),
      cv: tags.cv?.toLocaleLowerCase() ?? null,
    });
  }

  let oldest: UpstreamAuthenticationClaim | null = null;

  if (result === "pass" && chainLength > 1) {
    const first = all.flatMap((field) => {
      if (field.name !== "arc-authentication-results") return [];
      const parsed = parseArcAuthenticationResults(field.value);

      return parsed?.instance === 1 ? [parsed] : [];
    })[0];

    oldest = first ? claimFrom(first) : null;
  }

  return {
    result,
    chainLength,
    sealers: [...sealers.values()].sort(
      (left, right) => left.instance - right.instance
    ),
    oldest,
  };
}

/**
 * Header-derived sender authentication. Only the Authentication-Results,
 * Received-SPF and ARC headers Cloudflare prepended are trusted; anything
 * below its block is sender-controlled and is kept only as display claims.
 */
export function parseInboundAuthentication(input: {
  raw: string;
  fromAddress: string | null;
  envelopeFrom?: string | null;
  now?: number;
}): InboundAuthentication {
  const now = input.now ?? Date.now();
  const fields = headerFields(input.raw);
  const block = trustedHeaderBlock(fields);
  const fromDomainHint = addressDomain(input.fromAddress);

  if (!block) {
    return emptyAuthentication(
      now,
      fromDomainHint,
      "not_cloudflare",
      input.envelopeFrom ?? null
    );
  }

  const authenticationResults = block.trusted.flatMap((field) => {
    if (field.name !== "authentication-results") return [];
    const parsed = parseAuthenticationResults(field.value);

    return parsed?.authservId === CLOUDFLARE_AUTHSERV_ID
      ? [{ field, parsed }]
      : [];
  })[0];

  const receivedSpf = block.trusted.flatMap((field) => {
    if (field.name !== "received-spf") return [];
    const parsed = parseReceivedSpf(field.value);

    return parsed?.pairs.receiver?.toLocaleLowerCase() ===
      CLOUDFLARE_AUTHSERV_ID
      ? [parsed]
      : [];
  })[0];

  const scoreField = block.trusted.find(
    (field) => field.name === "x-cf-spamh-score"
  );

  const score =
    scoreField && /^\s*\d+(?:\.\d+)?\s*$/u.test(scoreField.value)
      ? Number(scoreField.value)
      : null;

  const upstream = block.below
    .flatMap((field) => {
      if (field.name !== "authentication-results") return [];
      const parsed = parseAuthenticationResults(field.value);

      return parsed ? [claimFrom(parsed)] : [];
    })
    .slice(0, MAX_UPSTREAM_CLAIMS);

  const ignoredCloudflareClaims = block.below.filter(claimsCloudflare).length;
  const cloudflareHop = block.hop;

  if (!authenticationResults) {
    return {
      ...emptyAuthentication(
        now,
        fromDomainHint,
        "missing_results",
        input.envelopeFrom ?? null
      ),
      remoteIp:
        normalizeIp(receivedSpf?.pairs["client-ip"]) ?? cloudflareHop.ip,
      helo: receivedSpf?.pairs.helo ?? cloudflareHop.from,
      envelopeFrom:
        receivedSpf?.pairs["envelope-from"] || input.envelopeFrom || null,
      spamScore: score,
      upstream,
      ignoredCloudflareClaims,
    };
  }

  const { results } = authenticationResults.parsed;
  const dmarcResult = results.find((result) => result.method === "dmarc");

  const fromDomain =
    fromDomainHint ?? addressDomain(dmarcResult?.props["header.from"]);

  const spfResults = results.filter((result) => result.method === "spf");

  const spfMailFrom =
    spfResults.find((result) => result.props["smtp.mailfrom"]) ??
    spfResults.find((result) => !result.props["smtp.helo"]);

  const spfHelo = spfResults.find((result) => result.props["smtp.helo"]);

  const envelopeFrom =
    spfMailFrom?.props["smtp.mailfrom"] ||
    receivedSpf?.pairs["envelope-from"] ||
    input.envelopeFrom ||
    null;

  const remoteIp =
    normalizeIp(
      results.find((result) => result.props["smtp.remote-ip"])?.props[
        "smtp.remote-ip"
      ]
    ) ??
    normalizeIp(receivedSpf?.pairs["client-ip"]) ??
    cloudflareHop.ip;

  const signatures = dkimSignatureTags(fields);

  const dkim: DkimResult[] = results.flatMap((result) => {
    if (result.method !== "dkim") return [];
    const verdict = authResult(result.result);
    const identity = result.props["header.i"] ?? null;

    const domain =
      addressDomain(result.props["header.d"]) ?? addressDomain(identity);

    if (!verdict || !domain) return [];
    const signature = matchSignature(result, domain, signatures);

    return [
      {
        result: verdict,
        domain,
        identity,
        selector: result.props["header.s"] ?? null,
        bPrefix: result.props["header.b"] ?? null,
        aligned: relaxedAligned(domain, fromDomain),
        signedHeaders: signature?.signedHeaders ?? null,
      },
    ];
  });

  const spfVerdict = authResult(spfMailFrom?.result);
  const spfDomain = addressDomain(envelopeFrom);

  const spf = spfVerdict
    ? {
        result: spfVerdict,
        domain: spfDomain,
        aligned: relaxedAligned(spfDomain, fromDomain),
      }
    : null;

  const spfHeloVerdict = authResult(spfHelo?.result);
  const dmarcVerdict = authResult(dmarcResult?.result);

  const dmarc = dmarcVerdict
    ? {
        result: dmarcVerdict,
        headerFrom: addressDomain(dmarcResult?.props["header.from"]),
        policy: dmarcPolicy(dmarcResult?.props["policy.dmarc"]),
        alignedVia: [
          ...(dkim.some((item) => item.result === "pass" && item.aligned)
            ? ["dkim" as const]
            : []),
          ...(spf?.result === "pass" && spf.aligned ? ["spf" as const] : []),
        ],
      }
    : null;

  const arc = arcSummary(
    block.trusted,
    fields,
    results.find((result) => result.method === "arc")
  );

  const parts = { spf, dkim, dmarc, arc };

  return {
    source: "headers",
    version: 1,
    authservId: CLOUDFLARE_AUTHSERV_ID,
    parsedAt: now,
    remoteIp,
    helo:
      spfHelo?.props["smtp.helo"] ??
      receivedSpf?.pairs.helo ??
      cloudflareHop.from,
    envelopeFrom,
    fromDomain,
    ...parts,
    spfHelo: spfHeloVerdict
      ? {
          result: spfHeloVerdict,
          domain: addressDomain(spfHelo?.props["smtp.helo"]),
        }
      : null,
    spamScore: score,
    ...verdictFor(parts),
    upstream,
    ignoredCloudflareClaims,
    trustedHeader: authenticationResults.field.value.slice(
      0,
      MAX_TRUSTED_HEADER_LENGTH
    ),
  };
}

// --- List-Unsubscribe (RFC 2369 / RFC 8058) --------------------------------

function httpsUnsubscribeUrl(value: string) {
  if (value.length > 2048) return null;

  try {
    const url = new URL(value);

    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.replaceAll(/^\[|\]$/gu, "");

    if (normalizeIp(host) || !host.includes(".")) return null;

    return url.toString();
  } catch {
    return null;
  }
}

function mailtoUnsubscribeUrl(value: string) {
  if (value.length > 2048 || !/^mailto:/iu.test(value)) return null;

  try {
    const url = new URL(value);
    const recipient = decodeURIComponent(url.pathname);

    return /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u.test(recipient)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Unsubscribe methods a client may offer. One-click requires RFC 8058's
 * Post header and an aligned passing DKIM signature whose `h=` covers both
 * list headers; the alignment requirement is our own extra safeguard.
 */
export function parseListUnsubscribe(
  raw: string,
  authentication: Pick<InboundAuthentication, "dkim">
): ListUnsubscribe | null {
  const fields = headerFields(raw);

  const header = fields.find(
    (field) => field.name === "list-unsubscribe"
  )?.value;

  if (!header) return null;

  const uris = [...header.matchAll(/<([^>]*)>/gu)].map((match) =>
    match[1].replaceAll(/\s+/gu, "")
  );

  const httpsUrl = uris.map(httpsUnsubscribeUrl).find(Boolean) ?? null;
  const mailto = uris.map(mailtoUnsubscribeUrl).find(Boolean) ?? null;

  const result = (reason: ListUnsubscribe["reason"]): ListUnsubscribe => ({
    httpsUrl,
    mailto,
    oneClick: reason === null,
    reason,
  });

  if (!httpsUrl && !mailto) return result("invalid-uri");

  if (!httpsUrl) return result("no-https");

  const post = fields.find(
    (field) => field.name === "list-unsubscribe-post"
  )?.value;

  if (
    post?.replaceAll(/\s+/gu, "").toLocaleLowerCase() !==
    "list-unsubscribe=one-click"
  ) {
    return result("no-post");
  }

  const covering = authentication.dkim.filter(
    (signature) =>
      signature.result === "pass" &&
      signature.signedHeaders?.includes("list-unsubscribe")
  );

  if (!covering.length) return result("unsigned");

  const coveringBoth = covering.filter((signature) =>
    signature.signedHeaders?.includes("list-unsubscribe-post")
  );

  if (!coveringBoth.length) return result("post-not-signed");

  return result(
    coveringBoth.some((signature) => signature.aligned) ? null : "unaligned"
  );
}

/** Header-derived authentication and unsubscribe data stored on the email row. */
export function inboundHeaderMetadata(input: {
  rawHeaders: string;
  fromAddress: string | null;
  envelopeFrom?: string | null;
  now?: number;
}) {
  const authentication = parseInboundAuthentication({
    raw: input.rawHeaders,
    fromAddress: input.fromAddress,
    envelopeFrom: input.envelopeFrom,
    now: input.now,
  });

  return {
    authenticationResultsJson: authentication,
    listUnsubscribeJson: parseListUnsubscribe(input.rawHeaders, authentication),
  };
}
