import { signatureHtmlWithName } from "../../shared/signature";
import { storedImagesHtml } from "./rich-content";
import type { Mailbox } from "./types";

/** Where the app shows a saved signature image (worker/mail/signature-routes.ts). */
export function signatureImageUrl(ownerId: string, contentId: string) {
  return `/api/mail/signature-images/${encodeURIComponent(ownerId)}/${encodeURIComponent(contentId)}`;
}

/** A saved signature as editor content, its images shown from where they are stored. */
export function signatureEditorHtml(
  signature: { ownerId: string; html: string },
  html = signature.html
) {
  return storedImagesHtml(html, signature.ownerId, (contentId) =>
    signatureImageUrl(signature.ownerId, contentId)
  );
}

/**
 * What a new message (`new`) or a reply or forward (`reply`) from `mailbox`
 * opens with: an empty line, then the signature that applies with `{name}`
 * filled in, ready to edit. Empty when there is none or it is switched off.
 */
export function messageSignatureHtml(
  mailbox: Pick<Mailbox, "signature">,
  kind: "new" | "reply",
  senderName: string
) {
  const { signature } = mailbox;

  if (
    !signature ||
    !(kind === "new" ? signature.useOnNew : signature.useOnReply)
  ) {
    return "";
  }

  return `<p></p>${signatureEditorHtml(
    signature,
    signatureHtmlWithName(signature.html, senderName)
  )}`;
}
