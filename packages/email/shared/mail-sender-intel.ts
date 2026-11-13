/**
 * Point-in-time facts about the server that delivered an inbound message,
 * gathered over DNS-over-HTTPS at ingestion (or lazily on first view) by
 * `worker/mail/sender-intel.ts`. Every lookup fails open with its own status.
 */

export type LookupStatus = "ok" | "nxdomain" | "timeout" | "error" | "skipped";

export type SpamhausZone = "zen" | "dbl";

export type SpamhausListing = {
  zone: SpamhausZone;
  /** The IP (ZEN) or registrable domain (DBL) that is listed. */
  target: string;
  /** Return code, e.g. 127.0.0.2 or 127.0.1.4. */
  code: string;
  /** Human-readable list name, e.g. "SBL" or "DBL phishing domain". */
  list: string;
  /** "policy" listings (PBL) describe address space, not abuse. */
  severity: "abuse" | "policy";
};

export type SpamhausCheck = {
  status: LookupStatus;
  listings: SpamhausListing[];
  /** Set when Spamhaus answered with a 127.255.255.x error code. */
  error: string | null;
};

export type SpamhausResult = {
  zen: SpamhausCheck;
  dbl: SpamhausCheck & { domains: string[] };
};

export type BimiStatus = "ok" | "none" | "invalid" | "error";

export type BimiResult = {
  /** Domain whose BIMI record was used (From domain or its organizational domain). */
  domain: string;
  status: BimiStatus;
  /** Why no logo is shown, for "Show original". */
  reason: string | null;
};

export type SenderIntel = {
  version: 1;
  /** "demo" rows carry pre-computed values instead of live lookups. */
  source: "live" | "demo";
  checkedAt: number;
  ip: string | null;
  ipVersion: 4 | 6 | null;
  ptr: {
    status: LookupStatus;
    names: string[];
    /** The PTR name whose A/AAAA records contain the IP. */
    confirmed: string | null;
    /** Forward-confirmed reverse DNS. */
    fcrdns: boolean | null;
    /** The name looks like an auto-generated access-network name. */
    generic: boolean | null;
  };
  /** HELO equals a PTR name or shares its organizational domain. */
  heloMatchesPtr: boolean | null;
  network: {
    status: LookupStatus;
    asn: number | null;
    asName: string | null;
    prefix: string | null;
    /** ISO 3166-1 alpha-2, uppercase. */
    country: string | null;
    registry: string | null;
  };
  /** Present only when an administrator configured a Spamhaus DQS key. */
  spamhaus: SpamhausResult | null;
  /** Present only when DMARC passed with an enforcing policy. */
  bimi: BimiResult | null;
};

export type SecurityWarning =
  | {
      kind: "dbl_listed";
      severity: "danger";
      domains: string[];
      lists: string[];
      /** The From domain itself is listed, not only a link domain. */
      senderDomain: boolean;
    }
  | {
      kind: "zen_listed";
      severity: "danger" | "caution";
      ip: string;
      lists: string[];
    }
  | {
      kind: "lookalike_domain";
      severity: "danger";
      domain: string;
      resembles: string;
    }
  | { kind: "display_name_impersonation"; severity: "danger"; name: string }
  | { kind: "embedded_address"; severity: "caution"; claimed: string }
  | { kind: "unverified_sender"; severity: "caution"; domain: string | null }
  /** Replies go to another organization than the one in From. */
  | {
      kind: "reply_to_mismatch";
      severity: "caution";
      address: string;
      domain: string;
    }
  /**
   * Written for another address and forwarded here. Danger when it is an
   * account notice from a large provider about someone else's account.
   */
  | {
      kind: "addressed_elsewhere";
      severity: "danger" | "caution";
      addressedTo: string;
      forwardedVia: string | null;
      accountNotice: boolean;
    };

/** Who a message was written for and how it reached this mailbox, recorded at ingestion. */
export type DeliveryFacts = {
  /** The RCPT TO this mailbox received the message at. */
  deliveredTo: string | null;
  /** First To/Cc address when none of them is this mailbox or a workspace address. */
  addressedTo: string | null;
  /** Mail to that address reached this mailbox from several senders before (the person's own forwarding). */
  knownAddressee: boolean;
  /** Organization that relayed the message after the author's server, when forwarding is evident. */
  forwardedVia: string | null;
};

export type SecurityWarningKind = SecurityWarning["kind"];

/** Country flag emoji from an ISO 3166-1 alpha-2 code. */
export function countryFlag(code: string | null | undefined) {
  if (!code || !/^[A-Z]{2}$/u.test(code)) return null;

  return String.fromCodePoint(
    ...[...code].map((char) => 0x1_f1_e6 + char.charCodeAt(0) - 65)
  );
}
