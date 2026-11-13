import { normalizeEmail } from "@open-workspace/core/module";
import type { Header } from "postal-mime";

import type { MailAddress } from "../mailbox/model";

const MAX_REFERENCE_IDS = 100;
const MAX_REFERENCE_BYTES = 12 * 1024;
const MAX_MESSAGE_ID_BYTES = 900;
const textEncoder = new TextEncoder();

export function boundedMessageIds(values: string[]) {
  const unique = [
    ...new Set(
      values.flatMap((item) => {
        const trimmed = item.trim();

        return trimmed ? [trimmed] : [];
      })
    ),
  ];

  const newestFirst: string[] = [];
  let bytes = 0;

  for (const value of unique.reverse()) {
    if (newestFirst.length >= MAX_REFERENCE_IDS) break;
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
    : parent.inReplyToJson.length === 1
      ? parent.inReplyToJson
      : [];

  return {
    inReplyTo: [parentMessageId],
    references: boundedMessageIds([...ancestry, parentMessageId]),
  };
}

export function address(
  email: string,
  name: string | null = null
): MailAddress {
  return { address: normalizeEmail(email), name: name?.trim() || null };
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
