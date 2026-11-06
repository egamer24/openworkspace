import { isValidExternalEmailAddress } from "../../shared/mail";
import type {
  MailAddress,
  SpamReason,
  SpamVerdict,
  StoredAttachment,
} from "../mailbox/model";

/**
 * Local spam scoring. Every signal is computed inside the Worker from the
 * message header block and fields already parsed for storage; no message
 * content is sent to another service.
 */

export const SPAM_HEADER_SCAN_BYTES = 64 * 1024;
export const DEFAULT_SPAM_THRESHOLD = 70;
export const DEFAULT_SUSPICIOUS_THRESHOLD = 40;
export const MAX_SPAM_SENDER_RULES = 1_000;
export const spamSenderLists = ["allow", "block"] as const;
export type SpamSenderList = (typeof spamSenderLists)[number];

export type SpamThresholds = {
  spamThreshold: number;
  suspiciousThreshold: number;
};

export type SpamAssessment = {
  score: number;
  verdict: SpamVerdict;
  reasons: SpamReason[];
  senderList: SpamSenderList | null;
};

export type MimeHeader = { name: string; value: string };

export type AuthenticationVerdicts = {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  dmarcPolicyNone: boolean;
};

export type SenderRelationship = {
  address: boolean;
  domain: boolean;
};

const HTML_SCAN_CHARACTERS = 512 * 1024;
const MAX_SCANNED_LINKS = 200;
const EXCESSIVE_RECIPIENTS = 25;
const decoder = new TextDecoder();

// Large consumer providers: having written to one person there says nothing
// about another sender on the same domain.
const sharedMailDomains = new Set([
  "aol.com",
  "gmail.com",
  "gmx.com",
  "gmx.net",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.com",
  "mail.ru",
  "me.com",
  "msn.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "yahoo.com",
  "yandex.ru",
  "zoho.com",
]);

const executableExtensions = new Set([
  "app", "bat", "cmd", "com", "cpl", "dll", "exe", "hta", "jar", "js", "jse",
  "lnk", "msi", "msp", "pif", "ps1", "psm1", "reg", "scf", "scr", "vbe", "vbs",
  "wsf", "wsh",
]);
const macroOfficeExtensions = new Set([
  "docm", "dotm", "potm", "ppam", "ppsm", "pptm", "sldm", "xlam", "xlsm", "xltm",
]);
const archiveExtensions = new Set([
  "7z", "ace", "arj", "bz2", "cab", "gz", "img", "iso", "lzh", "rar", "tar",
  "tgz", "vhd", "vhdx", "xz", "z", "zip",
]);

/** Parses only the top-level header block, reading at most 64 KB. */
export function readHeaderBlock(raw: ArrayBuffer): MimeHeader[] {
  const text = decoder.decode(
    new Uint8Array(raw, 0, Math.min(raw.byteLength, SPAM_HEADER_SCAN_BYTES)),
  );
  const end = text.search(/\r?\n\r?\n/u);
  return (end === -1 ? text : text.slice(0, end))
    .replace(/\r?\n[ \t]+/gu, " ")
    .split(/\r?\n/u)
    .flatMap((line) => {
      const separator = line.indexOf(":");
      return separator > 0
        ? [{
            name: line.slice(0, separator).trim().toLowerCase(),
            value: line.slice(separator + 1).trim(),
          }]
        : [];
    });
}

/** Cloudflare Email Routing's authentication service identifier. */
export const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

/**
 * Cloudflare prepends one Authentication-Results header with authserv-id
 * mx.cloudflare.net before invoking the Worker, and documents that only that
 * header is trustworthy: any other one, including ARC results, may have been
 * written by the sender. So only the first header is read, and only if it
 * comes from Cloudflare.
 */
export function parseAuthenticationResults(
  headers: MimeHeader[],
): AuthenticationVerdicts | null {
  const header = headers.find((item) => item.name === "authentication-results");
  const authservId = header?.value.split(";", 1)[0]?.trim().split(/\s+/u, 1)[0]?.toLowerCase();
  if (!header || authservId !== CLOUDFLARE_AUTHSERV_ID) return null;
  const results: AuthenticationVerdicts = {
    spf: null,
    dkim: null,
    dmarc: null,
    dmarcPolicyNone: false,
  };
  for (const clause of header.value.split(";")) {
    const match = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)/iu.exec(clause);
    if (!match) continue;
    const method = match[1]!.toLowerCase() as "spf" | "dkim" | "dmarc";
    const result = match[2]!.toLowerCase();
    // A message can carry several DKIM signatures; one valid one is enough.
    if (method === "dkim" && results.dkim === "pass") continue;
    if (method !== "dkim" && results[method]) continue;
    results[method] = result;
    if (method === "dmarc") {
      results.dmarcPolicyNone = /\b(?:p|policy\.dmarc)\s*=\s*none\b/iu.test(clause);
    }
  }
  return results;
}

export function authenticationReasons(
  results: AuthenticationVerdicts | null,
): SpamReason[] {
  if (!results) return [];
  const reasons: SpamReason[] = [];
  if (results.dmarc === "fail") {
    reasons.push(results.dmarcPolicyNone
      ? { points: 25, reason: "DMARC failed (the sender's domain does not enforce a policy)" }
      : { points: 45, reason: "DMARC failed: the sender's domain did not authorize this message" });
  } else if (results.dmarc === "pass") {
    reasons.push({ points: -15, reason: "DMARC passed: the sender's domain is verified" });
  }
  if (results.spf === "fail") {
    reasons.push({ points: 15, reason: "SPF failed" });
  } else if (results.spf === "softfail") {
    reasons.push({ points: 8, reason: "SPF soft-failed" });
  }
  if (results.dkim === "fail") {
    reasons.push({ points: 15, reason: "DKIM signature failed" });
  }
  if (
    results.dmarc !== "pass"
    && results.spf !== "pass"
    && results.dkim !== "pass"
    && results.dmarc !== "fail"
  ) {
    reasons.push({ points: 10, reason: "The message is not authenticated" });
  }
  return reasons;
}

function addressDomain(value: string) {
  const separator = value.lastIndexOf("@");
  return separator === -1 ? "" : value.slice(separator + 1).toLowerCase();
}

export function relationshipReasons(
  relationship: SenderRelationship,
  sender: string,
  authentication: AuthenticationVerdicts | null,
): SpamReason[] {
  // A failed DMARC check means the From address cannot be trusted.
  if (authentication?.dmarc === "fail") return [];
  if (relationship.address) {
    return [{ points: -40, reason: "You have written to this sender before" }];
  }
  if (relationship.domain && !sharedMailDomains.has(addressDomain(sender))) {
    return [{ points: -20, reason: "You have written to this sender's domain before" }];
  }
  return [];
}

export function senderListReasons(list: SpamSenderList | null): SpamReason[] {
  if (list === "allow") {
    return [{ points: -100, reason: "The sender is on this mailbox's allow list" }];
  }
  if (list === "block") {
    return [{ points: 100, reason: "The sender is on this mailbox's block list" }];
  }
  return [];
}

/** Lookup keys for a sender: the address, its domain, and parent domains. */
export function spamSenderCandidates(sender: string) {
  const address = sender.trim().toLowerCase();
  const labels = addressDomain(address).split(".");
  const domains = labels
    .slice(0, -1)
    .map((_, index) => labels.slice(index).join("."));
  return [address, ...domains].filter(Boolean);
}

/** The allow list always wins, so a domain block can carry address exceptions. */
export function matchSenderList(lists: SpamSenderList[]): SpamSenderList | null {
  if (lists.includes("allow")) return "allow";
  return lists.includes("block") ? "block" : null;
}

export function normalizeSpamSenderEntry(value: string) {
  const entry = value.trim().toLowerCase().replace(/^(?:\*\.|@)/u, "");
  if (entry.includes("@")) {
    return isValidExternalEmailAddress(entry) ? entry : null;
  }
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/u
    .test(entry)
    ? entry
    : null;
}

function urlHost(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function sameSite(left: string, right: string) {
  return left === right
    || left.endsWith(`.${right}`)
    || right.endsWith(`.${left}`);
}

/** Finds a link whose visible text names one domain but whose target is another. */
export function mismatchedLink(html: string) {
  const anchors = html
    .slice(0, HTML_SCAN_CHARACTERS)
    .matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/giu);
  let scanned = 0;
  for (const anchor of anchors) {
    if (++scanned > MAX_SCANNED_LINKS) break;
    const hrefHost = urlHost(anchor[1] ?? anchor[2] ?? anchor[3] ?? "");
    const text = anchor[4]!.replace(/<[^>]*>/gu, "").trim();
    const textHost = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/iu
      .exec(text)?.[1]
      ?.toLowerCase();
    if (hrefHost && textHost && !sameSite(textHost, hrefHost)) {
      return { textHost, hrefHost };
    }
  }
  return null;
}

export function structureReasons(input: {
  from: MailAddress;
  recipientCount: number;
  html: string | null;
  hasTextPart: boolean;
}): SpamReason[] {
  const reasons: SpamReason[] = [];
  const displayedAddress = input.from.name
    ?.match(/[^\s<>"'(),;:@]+@[^\s<>"'(),;:@]+\.[a-z]{2,}/iu)?.[0]
    ?.toLowerCase();
  if (displayedAddress && displayedAddress !== input.from.address.toLowerCase()) {
    reasons.push({
      points: 25,
      reason: `The display name shows ${displayedAddress}, but the message is from ${input.from.address}`,
    });
  }
  if (input.html && !input.hasTextPart) {
    reasons.push({ points: 8, reason: "HTML-only message without a plain-text version" });
  }
  const link = input.html ? mismatchedLink(input.html) : null;
  if (link) {
    reasons.push({
      points: 20,
      reason: `A link labeled ${link.textHost} points to ${link.hrefHost}`,
    });
  }
  if (input.recipientCount > EXCESSIVE_RECIPIENTS) {
    reasons.push({
      points: 10,
      reason: `Sent to ${input.recipientCount} visible recipients`,
    });
  }
  return reasons;
}

function extension(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).trim().toLowerCase();
}

export function attachmentReasons(
  attachments: Array<Pick<StoredAttachment, "filename">>,
): SpamReason[] {
  const categories = [
    { extensions: executableExtensions, points: 40, label: "an executable or script" },
    { extensions: macroOfficeExtensions, points: 20, label: "a macro-enabled Office file" },
    { extensions: archiveExtensions, points: 10, label: "an archive or disk image" },
  ];
  return categories.flatMap((category) => {
    const file = attachments.find((item) =>
      category.extensions.has(extension(item.filename))
    );
    return file
      ? [{ points: category.points, reason: `Attachment ${file.filename} is ${category.label}` }]
      : [];
  });
}

export function assessSpam(
  input: {
    authentication: AuthenticationVerdicts | null;
    relationship: SenderRelationship;
    senderList: SpamSenderList | null;
    from: MailAddress;
    recipientCount: number;
    html: string | null;
    hasTextPart: boolean;
    attachments: Array<Pick<StoredAttachment, "filename">>;
  },
  thresholds: SpamThresholds,
): SpamAssessment {
  const reasons = [
    ...senderListReasons(input.senderList),
    ...authenticationReasons(input.authentication),
    ...relationshipReasons(input.relationship, input.from.address, input.authentication),
    ...structureReasons(input),
    ...attachmentReasons(input.attachments),
  ];
  const score = Math.min(
    100,
    Math.max(0, reasons.reduce((total, item) => total + item.points, 0)),
  );
  const verdict: SpamVerdict = input.senderList === "allow"
    ? "clean"
    : input.senderList === "block" || score >= thresholds.spamThreshold
      ? "spam"
      : score >= thresholds.suspiciousThreshold
        ? "suspicious"
        : "clean";
  return { score, verdict, reasons, senderList: input.senderList };
}
