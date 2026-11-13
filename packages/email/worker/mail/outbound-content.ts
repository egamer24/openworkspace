import {
  LINKED_ATTACHMENT_TEXT_PREFIX,
  linkedAttachmentTextToken,
} from "../../shared/mail";
import type { Email } from "../mailbox/schema";

const MAX_CONTEXT_CHARACTERS = 24_000;

type ContentSource = Pick<
  Email,
  | "fromJson"
  | "toJson"
  | "ccJson"
  | "subject"
  | "timelineAt"
  | "bodyText"
  | "preview"
>;

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function displayAddress(email: ContentSource) {
  const from = email.fromJson[0];

  if (!from) return "Unknown sender";

  return from.name ? `${from.name} <${from.address}>` : from.address;
}

function clippedBody(email: ContentSource) {
  const value =
    email.bodyText?.trim() || email.preview.trim() || "No text body";

  if (value.length <= MAX_CONTEXT_CHARACTERS) return value;

  return `${value.slice(0, MAX_CONTEXT_CHARACTERS).trimEnd()}\n[Context truncated]`;
}

function metadataLines(email: ContentSource) {
  return [
    `From: ${displayAddress(email)}`,
    `Date: ${email.timelineAt.toISOString()}`,
    `Subject: ${email.subject}`,
    ...(email.toJson.length
      ? [`To: ${email.toJson.map((item) => item.address).join(", ")}`]
      : []),
    ...(email.ccJson.length
      ? [`Cc: ${email.ccJson.map((item) => item.address).join(", ")}`]
      : []),
  ];
}

export function contextForNewRecipient(email: ContentSource) {
  return [...metadataLines(email), "", clippedBody(email)].join("\n");
}

export function forwardedMessageText(email: ContentSource) {
  return [
    "Forwarded message",
    ...metadataLines(email),
    "",
    clippedBody(email),
  ].join("\n");
}

export function forwardedMessageHtml(email: ContentSource) {
  const metadata = metadataLines(email)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join("");

  return `<section data-forwarded-message><strong>Forwarded message</strong>${metadata}<pre style="white-space:pre-wrap">${escapeHtml(clippedBody(email))}</pre></section>`;
}

export function appendForwardedMessage(
  bodyText: string,
  bodyHtml: string | undefined,
  forwarded: ContentSource | null
) {
  if (!forwarded) return { bodyText, bodyHtml };
  const text = forwardedMessageText(forwarded);
  const nextText = `${bodyText.trimEnd()}${bodyText.trimEnd() ? "\n\n" : ""}${text}`;

  return {
    bodyText: nextText,
    bodyHtml: bodyHtml
      ? `${bodyHtml}${forwardedMessageHtml(forwarded)}`
      : undefined,
  };
}

export function textWithQuotedContext(
  bodyText: string,
  quotedText: string | null
) {
  if (!quotedText) return bodyText;

  const quote = quotedText
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return `${bodyText.trimEnd()}${bodyText.trimEnd() ? "\n\n" : ""}${quote}`;
}

export function htmlWithQuotedContext(
  bodyHtml: string,
  quotedText: string | null
) {
  if (!quotedText) return bodyHtml;

  return `${bodyHtml}<blockquote><pre style="white-space:pre-wrap">${escapeHtml(quotedText)}</pre></blockquote>`;
}

export function externalizeLinkedInlineImages(
  bodyHtml: string,
  attachments: {
    disposition: "attachment" | "inline";
    contentId: string | null;
    filename: string;
    downloadUrl: string;
  }[]
) {
  let nextHtml = bodyHtml;

  for (const attachment of attachments) {
    if (attachment.disposition !== "inline" || !attachment.contentId) continue;

    const escapedContentId = attachment.contentId.replaceAll(
      /[.*+?^${}()|[\]\\]/gu,
      "\\$&"
    );

    const image = new RegExp(
      `<img(?=[^>]*\\bsrc=(["'])cid:${escapedContentId}\\1)[^>]*>`,
      "giu"
    );

    nextHtml = nextHtml.replaceAll(
      image,
      `<a href="${escapeHtml(attachment.downloadUrl)}">${escapeHtml(attachment.filename)}</a>`
    );
  }

  return nextHtml;
}

type PositionedLinkedAttachment = {
  uploadId: string | null;
  filename: string;
  downloadUrl: string | null;
};

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const unresolvedLinkedAttachmentText = new RegExp(
  `\\[\\[${escapeRegExp(LINKED_ATTACHMENT_TEXT_PREFIX)}[^\\]]+\\]\\]`,
  "gu"
);

// oxlint-disable-next-line prefer-regex-literals -- the pattern is built with escaped backslashes in a template
const unresolvedLinkedAttachmentHtml = new RegExp(
  `<span(?=[^>]*\\bdata-linked-attachment=(["'])[^"']*\\1)[^>]*>[\\s\\S]*?<\\/span>`,
  "giu"
);

function linkedAttachmentHtml(filename: string, downloadUrl: string) {
  return [
    '<span data-linked-attachment-card style="display:block;margin:12px 0">',
    `<a href="${escapeHtml(downloadUrl)}" style="display:inline-block;box-sizing:border-box;max-width:100%;padding:10px 12px;border:1px solid #dadce0;border-radius:8px;color:#1967d2;text-decoration:none;font-family:Arial,sans-serif">`,
    `<strong style="color:#202124">${escapeHtml(filename)}</strong>`,
    '<span style="margin-left:8px;font-size:12px;color:#5f6368">Download file · link expires in 30 days</span>',
    "</a>",
    "</span>",
  ].join("");
}

/**
 * Download URLs only exist once the outgoing message has an id and token.
 * Composer nodes therefore carry an upload-id placeholder that is resolved
 * here, while preserving the position chosen in the editor.
 */
export function resolveLinkedAttachmentPlaceholders(input: {
  bodyText: string;
  bodyHtml: string | undefined;
  attachments: PositionedLinkedAttachment[];
}) {
  let { bodyText } = input;
  let { bodyHtml } = input;
  const textPlacedUploadIds = new Set<string>();
  const htmlPlacedUploadIds = new Set<string>();

  for (const attachment of input.attachments) {
    if (!attachment.uploadId) continue;
    const textToken = linkedAttachmentTextToken(attachment.uploadId);

    if (bodyText.includes(textToken)) {
      bodyText = bodyText.replaceAll(
        textToken,
        attachment.downloadUrl
          ? `${attachment.filename}: ${attachment.downloadUrl}`
          : ""
      );

      if (attachment.downloadUrl) {
        textPlacedUploadIds.add(attachment.uploadId);
      }
    }

    if (!bodyHtml) continue;

    const marker = escapeRegExp(attachment.uploadId);

    const placeholder = new RegExp(
      `<span(?=[^>]*\\bdata-linked-attachment=(["'])${marker}\\1)[^>]*>[\\s\\S]*?<\\/span>`,
      "giu"
    );

    let matched = false;
    bodyHtml = bodyHtml.replaceAll(placeholder, () => {
      matched = true;

      return attachment.downloadUrl
        ? linkedAttachmentHtml(attachment.filename, attachment.downloadUrl)
        : "";
    });

    if (matched && attachment.downloadUrl) {
      htmlPlacedUploadIds.add(attachment.uploadId);
    }
  }

  bodyText = bodyText.replaceAll(unresolvedLinkedAttachmentText, "");

  if (bodyHtml) {
    bodyHtml = bodyHtml.replaceAll(unresolvedLinkedAttachmentHtml, "");
  }

  return {
    bodyText: bodyText.replaceAll(/\n{3,}/gu, "\n\n"),
    bodyHtml,
    textPlacedUploadIds,
    htmlPlacedUploadIds,
  };
}
