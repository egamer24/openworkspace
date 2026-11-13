import { z } from "zod";

import type { ConversationCursorPosition } from "../mailbox";

const CURSOR_VERSION = 1;

function toBase64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  const binary = String.fromCharCode(...bytes);

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");
}

function fromBase64Url(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");

  const bytes = Uint8Array.from(atob(padded), (character) =>
    character.charCodeAt(0)
  );

  return new TextDecoder().decode(bytes);
}

export function encodeConversationCursor(position: ConversationCursorPosition) {
  return toBase64Url(
    JSON.stringify([CURSOR_VERSION, position.timelineAt, position.emailId])
  );
}

/** `[version, timelineAt, emailId]`, as encodeConversationCursor writes it. */
const ConversationCursor = z.tuple([
  z.literal(CURSOR_VERSION),
  z.int(),
  z.string().min(1),
]);

export function decodeConversationCursor(value: string) {
  try {
    const decoded = ConversationCursor.safeParse(
      JSON.parse(fromBase64Url(value))
    );

    if (!decoded.success) return null;
    const [, timelineAt, emailId] = decoded.data;

    return { timelineAt, emailId };
  } catch {
    return null;
  }
}
