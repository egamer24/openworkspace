/**
 * JMAP ids are limited to [A-Za-z0-9_-]. An OpenWorkspace object id is used
 * as-is when it is a plain word starting with a letter; anything else is
 * hex-encoded behind a leading "0". Neither form contains "-", which joins
 * the owning mailbox id to the object id: `<mailbox>-<object>[-<part>]`.
 */
const PLAIN_ID = /^[A-Za-z][A-Za-z0-9_]*$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeIdPart(value: string) {
  if (PLAIN_ID.test(value)) return value;
  return `0${[...encoder.encode(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function decodeIdPart(value: string): string | null {
  if (PLAIN_ID.test(value)) return value;
  if (!/^0(?:[0-9a-f]{2})+$/u.test(value)) return null;
  const bytes = new Uint8Array((value.length - 1) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(1 + index * 2, 3 + index * 2), 16);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function scopedId(mailboxId: string, objectId: string, part?: string) {
  return [mailboxId, objectId, ...(part === undefined ? [] : [part])]
    .map((value, index) => (index === 2 && part?.startsWith("_") ? value : encodeIdPart(value)))
    .join("-");
}

/** Returns [mailboxId, objectId, part?] or null for a malformed id. */
export function parseScopedId(id: unknown) {
  if (typeof id !== "string" || id.length > 255) return null;
  const pieces = id.split("-");
  if (pieces.length < 2 || pieces.length > 3) return null;
  const decoded = pieces.map((piece, index) =>
    index === 2 && piece.startsWith("_") ? piece : decodeIdPart(piece)
  );
  if (decoded.some((piece) => piece === null)) return null;
  const [mailboxId, objectId, part] = decoded as string[];
  return { mailboxId: mailboxId!, objectId: objectId!, part };
}

/**
 * One JMAP account spans every OpenWorkspace mailbox the user can access, and
 * each mailbox Durable Object has its own modification sequence. The account
 * state is the sorted list of `<mailbox>.<seq>.<r|w>` entries; the rights flag
 * lets Mailbox/changes report myRights changes. A different mailbox set means
 * the client must resynchronize (cannotCalculateChanges).
 */
export type AccountState = Map<string, { seq: number; canSend: boolean }>;

export function encodeState(state: AccountState) {
  return [...state.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([mailboxId, entry]) => `${encodeIdPart(mailboxId)}.${entry.seq}.${entry.canSend ? "w" : "r"}`)
    .join(",") || "empty";
}

export function decodeState(value: unknown): AccountState | null {
  if (typeof value !== "string") return null;
  const state: AccountState = new Map();
  if (value === "empty") return state;
  for (const item of value.split(",")) {
    const match = /^([^.]+)\.(\d{1,15})\.([rw])$/u.exec(item);
    const mailboxId = match ? decodeIdPart(match[1]!) : null;
    if (!match || !mailboxId) return null;
    state.set(mailboxId, { seq: Number(match[2]), canSend: match[3] === "w" });
  }
  return state;
}
