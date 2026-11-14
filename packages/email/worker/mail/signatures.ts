import { createDb } from "@open-workspace/core/module";
import { eq } from "drizzle-orm";

import { signatureHtmlWithName } from "../../shared/signature";
import { signatures } from "../db/schema";
import type { SignatureImage } from "../db/schema";
import { escapeHtml } from "./outbound-content";

export type Signature = {
  html: string;
  text: string;
  images: SignatureImage[];
  useOnNew: boolean;
  useOnReply: boolean;
};

/** Whose signature a message gets: the team address's, the sender's own, or none. */
export type SignatureOwner = { userId: string } | { mailboxId: string };

/**
 * A team address (no owner) uses its own signature; a person's own mailbox
 * uses their personal one. Sending from someone else's mailbox adds none.
 */
export function signatureOwner(
  mailbox: { id: string; ownerUserId: string | null },
  senderId: string
): SignatureOwner | null {
  if (mailbox.ownerUserId === null) return { mailboxId: mailbox.id };

  return mailbox.ownerUserId === senderId ? { userId: senderId } : null;
}

/** The R2 key prefix of an owner's signature images; never expires. */
export function signatureImagePrefix(owner: string) {
  return `signatures/${owner}/`;
}

export function signatureImageKey(owner: string, contentId: string) {
  return `${signatureImagePrefix(owner)}${contentId}`;
}

export function ownerId(owner: SignatureOwner) {
  return "userId" in owner ? owner.userId : owner.mailboxId;
}

export function ownerColumn(owner: SignatureOwner) {
  return "userId" in owner
    ? eq(signatures.userId, owner.userId)
    : eq(signatures.mailboxId, owner.mailboxId);
}

export async function loadSignature(
  env: Env,
  owner: SignatureOwner
): Promise<Signature | null> {
  const [row] = await createDb(env.DB)
    .select({
      html: signatures.html,
      text: signatures.text,
      images: signatures.images,
      useOnNew: signatures.useOnNew,
      useOnReply: signatures.useOnReply,
    })
    .from(signatures)
    .where(ownerColumn(owner))
    .limit(1);

  return row ?? null;
}

/** `{name}` becomes the sender's display name (shared/signature.ts). */
export function withSenderName(
  signature: Pick<Signature, "html" | "text">,
  name: string
) {
  return {
    html: signatureHtmlWithName(signature.html, name),
    text: signature.text.replaceAll("{name}", name),
  };
}

/**
 * The message with the signature appended, if it applies to this kind of
 * message. A text-only body gets an HTML part too, so images can show.
 */
export function appendSignature<
  T extends { bodyText: string; bodyHtml?: string },
>(
  input: T,
  signature: Signature | null,
  kind: "new" | "reply",
  senderName: string
): T & { bodyHtml?: string; signatureImages: SignatureImage[] } {
  const applies =
    signature && (kind === "new" ? signature.useOnNew : signature.useOnReply);

  if (!applies) return { ...input, signatureImages: [] };

  const { html, text } = withSenderName(signature, senderName);
  const body = input.bodyText.trimEnd();

  const bodyHtml =
    input.bodyHtml ??
    (body ? `<div style="white-space:pre-wrap">${escapeHtml(body)}</div>` : "");

  return {
    ...input,
    bodyText: body ? `${body}\n\n${text}` : text,
    bodyHtml: `${bodyHtml}<div data-signature><br>${html}</div>`,
    signatureImages: signature.images.filter((image) =>
      html.includes(`cid:${image.contentId}`)
    ),
  };
}

/** Deletes an owner's signature images except `keep` (content ids). */
export async function deleteSignatureImages(
  bucket: R2Bucket,
  owner: string,
  keep: ReadonlySet<string> = new Set()
) {
  const prefix = signatureImagePrefix(owner);
  // ponytail: one page; a signature holds far fewer than 1000 images.
  const page = await bucket.list({ prefix, limit: 1000 });

  const stale = page.objects
    .map((object) => object.key)
    .filter((key) => !keep.has(key.slice(prefix.length)));

  if (stale.length) await bucket.delete(stale);
}

/**
 * Appends the signature that applies when an API or MCP caller asks
 * (`includeSignature`). The web app puts it in the editor instead.
 */
export async function withSignature<
  T extends { bodyText: string; bodyHtml?: string; includeSignature?: boolean },
>(input: {
  env: Env;
  sender: { id: string; name: string };
  mailbox: { id: string; ownerUserId: string | null };
  kind: "new" | "reply";
  message: T;
}) {
  const owner = input.message.includeSignature
    ? signatureOwner(input.mailbox, input.sender.id)
    : null;

  if (!owner) return { ...input.message, signatureImages: [] };

  const signed = appendSignature(
    input.message,
    await loadSignature(input.env, owner),
    input.kind,
    input.sender.name
  );

  return {
    ...signed,
    signatureImages: signed.signatureImages.map((image) => ({
      ...image,
      r2Key: signatureImageKey(ownerId(owner), image.contentId),
    })),
  };
}
