import { createDb } from "@open-workspace/core/module";
import { eq } from "drizzle-orm";

import type { RichImage, StoredImageRef } from "../../shared/rich-content";
import { signatureHtmlWithName } from "../../shared/signature";
import { signatures } from "../db/schema";
import { appendRichContent, referencedStoredImages } from "./rich-content";
import type { InlineImage } from "./rich-content";

export type Signature = {
  html: string;
  text: string;
  images: RichImage[];
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

/** The R2 prefix of an owner's signature images (rich-content.ts); never expires. */
export function signatureImagePrefix(owner: string) {
  return `signatures/${owner}/`;
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
 * message, and the signature images to send inline.
 */
export function appendSignature<
  T extends { bodyText: string; bodyHtml?: string },
>(
  input: T,
  signature: (Signature & { ownerId: string }) | null,
  kind: "new" | "reply",
  senderName: string
): T & { bodyHtml?: string; inlineImages: InlineImage[] } {
  const applies =
    signature && (kind === "new" ? signature.useOnNew : signature.useOnReply);

  if (!applies) return { ...input, inlineImages: [] };

  return appendRichContent(
    input,
    { ...withSenderName(signature, senderName), images: signature.images },
    signatureImagePrefix(signature.ownerId)
  );
}

/**
 * The message as it is sent: signature images the web composer put in its
 * body by reference (`storedImages`), and the signature that applies when an
 * API or MCP caller asks for one (`includeSignature`), all to send inline.
 */
export async function withSignature<
  T extends {
    bodyText: string;
    bodyHtml?: string;
    includeSignature?: boolean;
    storedImages: StoredImageRef[];
  },
>(input: {
  env: Env;
  sender: { id: string; name: string };
  mailbox: { id: string; ownerUserId: string | null };
  kind: "new" | "reply";
  message: T;
}) {
  const { message, sender, mailbox } = input;
  const owner = signatureOwner(mailbox, sender.id);

  // The sender's own signature, and the team signature of the address they
  // send from: the only saved images a message may refer to.
  const owners: SignatureOwner[] = [{ userId: sender.id }];

  if (mailbox.ownerUserId === null) owners.push({ mailboxId: mailbox.id });

  const needed = owners.filter(
    (candidate) =>
      message.storedImages.some((ref) => ref.ownerId === ownerId(candidate)) ||
      (message.includeSignature &&
        owner &&
        ownerId(owner) === ownerId(candidate))
  );

  const loaded = await Promise.all(
    needed.map(async (candidate) => {
      const signature = await loadSignature(input.env, candidate);

      return signature && { ...signature, ownerId: ownerId(candidate) };
    })
  );

  const sources = loaded.flatMap((signature) =>
    signature
      ? [
          {
            ownerId: signature.ownerId,
            prefix: signatureImagePrefix(signature.ownerId),
            images: signature.images,
          },
        ]
      : []
  );

  const referenced = referencedStoredImages(message.storedImages, sources);

  const appended =
    message.includeSignature && owner
      ? appendSignature(
          message,
          loaded.find((signature) => signature?.ownerId === ownerId(owner)) ??
            null,
          input.kind,
          sender.name
        )
      : { ...message, inlineImages: [] };

  return {
    ...appended,
    inlineImages: [...referenced, ...appended.inlineImages],
  };
}
