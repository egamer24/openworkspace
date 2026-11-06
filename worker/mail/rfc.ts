import type { Header } from "postal-mime";
import { normalizeEmail } from "../lib/ids";
import type { MailAddress } from "../mailbox/model";

const MAX_REFERENCE_IDS = 100;
const MAX_REFERENCE_BYTES = 12 * 1024;
const MAX_MESSAGE_ID_BYTES = 900;
const textEncoder = new TextEncoder();

export function boundedMessageIds(values: string[]) {
  const unique = [...new Set(values.map((item) => item.trim()).filter(Boolean))];
  const newestFirst: string[] = [];
  let bytes = 0;
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    if (newestFirst.length >= MAX_REFERENCE_IDS) break;
    const value = unique[index]!;
    const valueBytes = textEncoder.encode(value).byteLength;
    if (valueBytes > MAX_MESSAGE_ID_BYTES) continue;
    const nextBytes = valueBytes + (newestFirst.length ? 1 : 0);
    if (bytes + nextBytes > MAX_REFERENCE_BYTES) continue;
    newestFirst.push(value);
    bytes += nextBytes;
  }
  return newestFirst.reverse();
}

export function messageIds(value: string | undefined) {
  if (!value) return [];
  const bracketed = value.match(/<[^<>]+>/gu);
  const values = bracketed ?? value.split(/\s+/u);
  return boundedMessageIds(values);
}

export function replyThreadHeaders(parent: {
  messageIdHeader: string | null;
  inReplyToJson: string[];
  referencesJson: string[];
}) {
  const parentMessageId = messageIds(parent.messageIdHeader ?? undefined)[0];
  if (!parentMessageId) return { inReplyTo: [], references: [] };
  const ancestry = parent.referencesJson.length
    ? parent.referencesJson
    : parent.inReplyToJson.length === 1 ? parent.inReplyToJson : [];
  return {
    inReplyTo: [parentMessageId],
    references: boundedMessageIds([...ancestry, parentMessageId]),
  };
}

export function address(address: string, name: string | null = null): MailAddress {
  return { address: normalizeEmail(address), name: name?.trim() || null };
}

export function headerValue(headers: Header[], name: string) {
  return headers.find((header) => header.key === name)?.value.trim() || null;
}

export function listId(headers: Header[]) {
  const value = headerValue(headers, "list-id");
  return value?.match(/<([^<>]+)>/u)?.[1] ?? value;
}

export function listPostAddress(value: string | null | undefined) {
  if (!value) return null;
  const match = /<mailto:([^?>]+)(?:\?[^>]*)?>/iu.exec(value);
  if (!match?.[1]) return null;
  try {
    return normalizeEmail(decodeURIComponent(match[1]));
  } catch {
    // Invalid list metadata must not make the containing message unreadable.
    return null;
  }
}

/**
 * Whether Cloudflare Email Routing's DMARC check passed for `fromAddress`.
 * Only the first Authentication-Results header is Cloudflare's (it
 * prepends it); any later copy came from the sender and is ignored.
 */
export function cloudflareDmarcPass(rawMime: ArrayBuffer | string, fromAddress: string) {
  const text = typeof rawMime === "string"
    ? rawMime
    : new TextDecoder().decode(rawMime.slice(0, 64 * 1024));
  const head = text.split(/\r?\n\r?\n/u, 1)[0]!.replace(/\r?\n[ \t]+/gu, " ");
  const header = head.split(/\r?\n/u).find((line) => /^authentication-results:/iu.test(line));
  if (!header) return false;
  const [authservId, ...results] = header
    .slice(header.indexOf(":") + 1)
    .replace(/\([^()]*\)/gu, " ")
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  if (authservId !== "mx.cloudflare.net") return false;
  const dmarc = results.find((result) => result.startsWith("dmarc="))?.split(/\s+/u);
  const domain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1).toLowerCase();
  return dmarc?.[0] === "dmarc=pass" && dmarc.includes(`header.from=${domain}`);
}
