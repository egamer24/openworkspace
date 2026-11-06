import { and, eq } from "drizzle-orm";
import { isValidBookingHandle } from "../../shared/booking";
import { createDb, type Database } from "../db/client";
import { bookingHandles, users } from "../db/schema";
import { base64UrlToBytes, bytesToBase64Url, randomToken } from "../lib/crypto";
import { createId } from "../lib/ids";
import { getMailboxAccess } from "../mail/access";
import {
  discardPreparedObjects,
  messageIdForRequest,
  outgoingRequestFingerprint,
  prepareOutgoingEmail,
  type OutgoingMessageInput,
} from "../mail/outbound";
import { mailboxStub } from "../mailbox";

export type BookingTokenPayload = {
  /** Host user id: routes the request to the right calendar. */
  u: string;
  /** Booking id. */
  b: string;
  /** Expiry, epoch seconds. */
  e: number;
};

const encoder = new TextEncoder();

function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** `<base64url JSON payload>.<base64url HMAC-SHA256>` */
export async function signBookingToken(secret: string, payload: BookingTokenPayload) {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** Reads the payload without checking it; only used to find the host. */
export function readBookingToken(token: string): BookingTokenPayload | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined || token.length > 1_000) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as Partial<BookingTokenPayload>;
    return typeof value.u === "string" && typeof value.b === "string" && Number.isInteger(value.e)
      ? { u: value.u, b: value.b, e: value.e! }
      : null;
  } catch {
    return null;
  }
}

export async function verifyBookingToken(secret: string, token: string, now = Date.now()) {
  const payload = readBookingToken(token);
  if (!payload || payload.e * 1_000 <= now) return null;
  const [body, signature] = token.split(".");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(base64UrlToBytes(signature!));
  } catch {
    return null;
  }
  // verify() compares in constant time.
  return await crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, encoder.encode(body!))
    ? payload
    : null;
}

/** The user's handle, created from their name on first use. */
export async function ensureBookingHandle(db: Database, user: { id: string; name: string }) {
  const existing = async () => (await db.select({ handle: bookingHandles.handle })
    .from(bookingHandles)
    .where(eq(bookingHandles.userId, user.id))
    .limit(1))[0]?.handle;
  const current = await existing();
  if (current) return current;
  const base = user.name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "").slice(0, 30);
  const candidates = [
    ...(isValidBookingHandle(base) ? [base] : []),
    ...Array.from({ length: 3 }, () => `${base || "user"}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/gu, "")}`)
      .filter(isValidBookingHandle),
  ];
  for (const handle of candidates) {
    await db.insert(bookingHandles).values({ userId: user.id, handle }).onConflictDoNothing();
    const stored = await existing();
    if (stored) return stored;
  }
  throw new Error("Could not allocate a booking handle");
}

export async function resolveBookingHandle(binding: D1Database, handle: string) {
  const [row] = await createDb(binding)
    .select({ userId: users.id, name: users.name })
    .from(bookingHandles)
    .innerJoin(users, eq(bookingHandles.userId, users.id))
    .where(and(eq(bookingHandles.handle, handle), eq(users.status, "active")))
    .limit(1);
  return row ?? null;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare Turnstile server-side validation. */
export async function verifyTurnstile(secret: string, token: string, remoteIp: string | null) {
  if (!token || token.length > 2_048) return false;
  const response = await fetch(SITEVERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
  });
  if (!response.ok) return false;
  const result = await response.json<{ success?: boolean }>();
  return result.success === true;
}

/**
 * Sends a booking email through the normal outbound path, so it is stored in
 * the sending mailbox's Sent folder. Returns false when the host no longer
 * has send access to the mailbox.
 */
export async function sendBookingEmail(input: {
  env: Env;
  requestUrl: string;
  userId: string;
  mailboxId: string;
  to: string;
  subject: string;
  text: string;
  ics?: string;
}) {
  const { env } = input;
  const access = await getMailboxAccess(createDb(env.DB), input.userId, input.mailboxId);
  if (!access?.canSend) return false;
  const compose: OutgoingMessageInput = {
    requestId: crypto.randomUUID(),
    mailboxId: input.mailboxId,
    userId: input.userId,
    to: [input.to],
    cc: [],
    bcc: [],
    subject: input.subject,
    bodyText: input.text,
    attachments: [],
  };
  const id = await messageIdForRequest(input.mailboxId, compose.requestId);
  const prepared = await prepareOutgoingEmail({
    env,
    requestUrl: input.requestUrl,
    compose,
    requestFingerprint: await outgoingRequestFingerprint(compose),
    id,
    conversationId: createId("conv"),
    related: null,
    forwarded: null,
    includeRelatedContext: false,
    fromAddress: access.address,
    fromName: access.displayName,
    now: new Date(),
  });
  if (input.ics) {
    const r2Key = `mailboxes/${input.mailboxId}/messages/${id}/attempts/${randomToken()}/attachments/att_1`;
    const content = encoder.encode(input.ics);
    await env.MAIL_STORAGE.put(r2Key, content, { httpMetadata: { contentType: "text/calendar; charset=utf-8" } });
    prepared.storageKeys.push(r2Key);
    prepared.email.attachmentsJson = [{
      id: "att_1",
      r2Key,
      filename: "invite.ics",
      contentType: "text/calendar",
      size: content.byteLength,
      contentId: null,
      disposition: "attachment",
      delivery: "attached",
      downloadTokenHash: null,
      downloadExpiresAt: null,
    }];
  }
  try {
    const submission = await mailboxStub(env, input.mailboxId).submitOutgoing(prepared.email);
    return submission.email.transportState === "submitted";
  } catch (error) {
    await discardPreparedObjects(env, prepared.storageKeys);
    throw error;
  }
}
