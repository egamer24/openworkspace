/**
 * Sender authentication as reported by Cloudflare Email Routing in the
 * headers it prepends to every inbound message. Parsed at ingestion (or
 * lazily from the stored original) by `worker/mail/auth-headers.ts`.
 */

export const authResults = [
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "policy",
] as const;

export type AuthResult = (typeof authResults)[number];

export type DmarcPolicy = "none" | "quarantine" | "reject";

export type DkimResult = {
  result: AuthResult;
  /** Signing domain: `header.d`, or the domain of `header.i`. */
  domain: string;
  identity: string | null;
  selector: string | null;
  /** RFC 6008 `header.b` prefix used to find the matching DKIM-Signature. */
  bPrefix: string | null;
  /** Organizational domain equals the From organizational domain. */
  aligned: boolean;
  /** Lowercased `h=` list of the matching DKIM-Signature, when found. */
  signedHeaders: string[] | null;
};

/** One sender-reported Authentication-Results header, shown but never trusted. */
export type UpstreamAuthenticationClaim = {
  authservId: string;
  spf: AuthResult | null;
  dkim: AuthResult | null;
  dmarc: AuthResult | null;
};

export type ArcSealer = {
  instance: number;
  domain: string | null;
  cv: string | null;
};

export type SenderVerdict =
  | "verified"
  | "unverified"
  | "suspicious"
  | "unavailable";

export type SenderVerdictReason =
  | "dmarc_pass"
  | "aligned_dkim"
  | "forwarded_arc"
  | "dmarc_fail"
  | "no_aligned_pass"
  | "partial"
  | "not_cloudflare"
  | "missing_results";

export type InboundAuthentication = {
  source: "headers";
  version: 1;
  /** authserv-id of the trusted Authentication-Results (mx.cloudflare.net). */
  authservId: string | null;
  parsedAt: number;
  /** smtp.remote-ip, else Received-SPF client-ip, else the Cloudflare hop IP. */
  remoteIp: string | null;
  helo: string | null;
  /** SMTP MAIL FROM (smtp.mailfrom / Received-SPF envelope-from). */
  envelopeFrom: string | null;
  /** Domain of the RFC 5322 From address the results were aligned against. */
  fromDomain: string | null;
  spf: { result: AuthResult; domain: string | null; aligned: boolean } | null;
  spfHelo: { result: AuthResult; domain: string | null } | null;
  dkim: DkimResult[];
  dmarc: {
    result: AuthResult;
    headerFrom: string | null;
    policy: DmarcPolicy | null;
    alignedVia: ("spf" | "dkim")[];
  } | null;
  arc: {
    result: "pass" | "fail" | "none";
    /** Instance of Cloudflare's own ARC set; i > 1 means an upstream chain exists. */
    chainLength: number;
    /** Earlier sealers (display only; Cloudflare validated the chain when result is pass). */
    sealers: ArcSealer[];
    /** Results recorded by the oldest sealer, when ARC passed. */
    oldest: UpstreamAuthenticationClaim | null;
  } | null;
  /** X-CF-SpamH-Score, 0..5. Experimental and passive per Cloudflare. */
  spamScore: number | null;
  verdict: SenderVerdict;
  verdictReason: SenderVerdictReason;
  /** Authentication-Results headers below the trusted block (sender-supplied). */
  upstream: UpstreamAuthenticationClaim[];
  /** Headers below the trusted block that claimed to come from Cloudflare. */
  ignoredCloudflareClaims: number;
  /** Raw trusted Authentication-Results value, capped. */
  trustedHeader: string | null;
};

export type ListUnsubscribeReason =
  | "invalid-uri"
  | "no-https"
  | "no-post"
  | "unsigned"
  | "unaligned"
  | "post-not-signed";

export type ListUnsubscribe = {
  httpsUrl: string | null;
  mailto: string | null;
  /** RFC 8058 one-click, and the signature covering both headers is aligned with From. */
  oneClick: boolean;
  /** Why one-click is not offered; null when it is. */
  reason: ListUnsubscribeReason | null;
};

/** Compact sender summary returned with every message. */
export type MessageSecurity = {
  verdict: SenderVerdict;
  verdictReason: SenderVerdictReason;
  fromDomain: string | null;
  /** Domain of the SMTP envelope sender (Gmail's "mailed-by"). */
  mailedBy: string | null;
  /** Passing DKIM domain, preferring the aligned one (Gmail's "signed-by"). */
  signedBy: string | null;
  /** Gmail's "via": shown when neither mailed-by nor signed-by aligns with From. */
  via: string | null;
  /** Organization that forwarded the message to this mailbox, when evident. */
  forwardedVia: string | null;
  /** The From domain is not one of this workspace's mail domains. */
  external: boolean;
  listUnsubscribe: ListUnsubscribe | null;
  /** Most serious first; the reader merges them into one banner. */
  warnings: import("./mail-sender-intel").SecurityWarning[];
  /** First message from this external address, and this mailbox never wrote to it. */
  firstTimeSender: boolean;
  /** Reply-To points at another organization than From (and the message is not from a list). */
  replyToMismatch: { address: string; domain: string } | null;
  /** Someone in this mailbox marked the sender as trusted; caution hints are hidden. */
  trusted: boolean;
};
