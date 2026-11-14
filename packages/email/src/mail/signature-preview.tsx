import { Button, useAuth } from "@open-workspace/core/ui";
import { X } from "lucide-react";

import { signatureHtmlWithName } from "../../shared/signature";
import { sanitizeComposerHtml } from "./sanitize-email-html";
import type { Mailbox } from "./types";

/** The URL the app shows a signature's `cid:` image from. */
function signatureImageUrl(ownerId: string, contentId: string) {
  return `/api/mail/signature-images/${encodeURIComponent(ownerId)}/${encodeURIComponent(contentId)}`;
}

/**
 * The signature the Worker appends to this reply (`includeSignature`), shown
 * under the plain-text reply box with `{name}` filled in. It can be removed
 * for this reply, not edited: the box is plain text and the signature may
 * hold images.
 */
export function ReplySignature({
  signature,
  disabled,
  onRemove,
}: {
  signature: NonNullable<Mailbox["signature"]>;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { user } = useAuth();

  const document = new DOMParser().parseFromString(
    sanitizeComposerHtml(
      signatureHtmlWithName(signature.html, user?.name ?? "")
    ),
    "text/html"
  );

  for (const image of document.querySelectorAll("img")) {
    const source = image.getAttribute("src") ?? "";

    if (source.startsWith("cid:")) {
      image.setAttribute(
        "src",
        signatureImageUrl(signature.ownerId, source.slice(4))
      );
    }
  }

  return (
    <div className="border-border/70 group/signature relative mx-3.5 mb-2 self-stretch border-t pt-2">
      <div
        className="composer-message-body text-muted-foreground pr-8 text-[0.8125rem] leading-[1.6] [&_img]:max-h-24"
        role="note"
        aria-label="Signature added when sent"
        // oxlint-disable-next-line react/no-danger -- sanitized like sent composer HTML
        dangerouslySetInnerHTML={{ __html: document.body.innerHTML }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute top-1.5 right-0"
        aria-label="Remove signature"
        title="Remove signature"
        disabled={disabled}
        onClick={onRemove}
      >
        <X />
      </Button>
    </div>
  );
}
