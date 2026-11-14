export {
  isValidExternalEmailAddress,
  normalizeExternalEmailAddress,
} from "@open-workspace/core/shared";

export const mailboxStates = ["active", "archive", "spam", "trash"] as const;

export type MailboxState = (typeof mailboxStates)[number];

/** Who outside the workspace an auto-reply answers: anyone, or only people the mailbox has written to. */
export const autoReplyAudiences = ["everyone", "knownSenders"] as const;

export type AutoReplyAudience = (typeof autoReplyAudiences)[number];

export type AutoReplyStatus = "off" | "scheduled" | "active" | "ended";

export const transportStates = [
  "received",
  "unconfirmed",
  "submitted",
  "failed",
] as const;

export type TransportState = (typeof transportStates)[number];

export const replyActionModes = [
  "reply",
  "reply_all",
  "continue",
  "reply_list",
] as const;

export type ReplyActionMode = (typeof replyActionModes)[number];

export type ReplyAction = {
  mode: ReplyActionMode;
  label: string;
  to: string[];
  cc: string[];
};

export type ReplyPlan = {
  defaultMode: ReplyActionMode;
  isGroup: boolean;
  participants: string[];
  actions: ReplyAction[];
};

export const deliveryStatuses = [
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
] as const;

export type DeliveryStatusName = (typeof deliveryStatuses)[number];

export type RecipientDeliveryStatus = {
  recipient: string;
  status: DeliveryStatusName;
  eventId: string;
  eventAt: number;
  smtpCode: string | null;
  detail: string | null;
};

/** Conversations in the first page of a folder's list (and each next one). */
export const CONVERSATION_PAGE_SIZE = 25;

/**
 * The realtime socket's only server message: `update:<version>`, sent when
 * the socket opens and after every change, where `<version>` is the
 * mailbox's change counter. Mail API reads return the counter they reflect,
 * so a client refetches only data older than the announced version.
 * `update:<version>:<bookmark>` also names the D1 bookmark after the
 * mailbox's latest counts write (see `mailbox_counts`): a client that reads
 * counts with it gets them at least as new as the announced version, even
 * from a D1 replica.
 */
export const MAILBOX_REALTIME_UPDATE = "update" as const;

export function mailboxRealtimeUpdate(
  version: number,
  bookmark: string | null
) {
  return `${MAILBOX_REALTIME_UPDATE}:${version}${bookmark ? `:${bookmark}` : ""}`;
}

/** The version (and bookmark) a realtime message announces, or null for anything else. */
export function parseMailboxRealtimeUpdate(message: string) {
  const match = /^update:(\d+)(?::([\w.:-]{1,256}))?$/u.exec(message);

  return match
    ? { version: Number(match[1]), bookmark: match[2] ?? null }
    : null;
}

export type MailboxRealtimeClientMessage = "visible" | "hidden";

type MailboxPushJobBase = {
  mailboxId: string;
  conversationId: string;
  messageId: string;
  occurredAt: number;
  sender: string;
  subject: string;
};

export type MailboxPushJob =
  | (MailboxPushJobBase &
      (
        | { type: "dispatch" }
        | {
            type: "deliver";
            targetSubscriptionId: string;
            mailboxDisplayName: string;
          }
      ))
  /** The mailbox's JMAP state moved; tell JMAP push subscribers. */
  | {
      type: "jmap-state";
      mailboxId: string;
      state: string;
      occurredAt: number;
    };

export const MAX_COMPOSER_ATTACHMENT_BYTES = 500_000_000;
export const MAX_COMPOSER_ATTACHMENT_COUNT = 10;
export const MAX_BULK_CONVERSATION_COUNT = 500;
export const MAX_CUSTOM_FOLDER_COUNT = 100;
export const MAX_MAIL_RECIPIENTS = 50;
export const EMAIL_SERVICE_MAX_BYTES = 5 * 1024 * 1024;
export const MIME_FIXED_OVERHEAD_BYTES = 128 * 1024;
export const LINKED_ATTACHMENT_TEXT_PREFIX = "openworkspace-attachment:";

const INLINE_COMPOSER_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function isComposerInlineImageContentType(value: string) {
  const mediaType =
    value.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? "";

  return INLINE_COMPOSER_IMAGE_TYPES.has(mediaType);
}

export function linkedAttachmentTextToken(uploadId: string) {
  return `[[${LINKED_ATTACHMENT_TEXT_PREFIX}${uploadId}]]`;
}

export function composerAttachmentLimitError(
  attachments: readonly { size: number }[]
) {
  if (attachments.length > MAX_COMPOSER_ATTACHMENT_COUNT) {
    return `Use at most ${MAX_COMPOSER_ATTACHMENT_COUNT} attachments`;
  }

  const totalBytes = attachments.reduce(
    (total, attachment) => total + attachment.size,
    0
  );

  if (totalBytes > MAX_COMPOSER_ATTACHMENT_BYTES) {
    return `Attachments are limited to ${Math.floor(MAX_COMPOSER_ATTACHMENT_BYTES / 1_000_000)} MB per message`;
  }

  return null;
}

type ComposerAttachmentSize = {
  id: string;
  size: number;
};

function byteLength(value: string | undefined) {
  return value ? new TextEncoder().encode(value).byteLength : 0;
}

function base64EncodedSize(size: number) {
  return 4 * Math.ceil(size / 3);
}

/**
 * Email Service applies its size limit after MIME serialization. Keep this
 * shared so the composer can preview the same attachment/link decision the
 * Worker will make when the message is submitted.
 */
export function attachmentsRequiringDownloadLinks(input: {
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments: ComposerAttachmentSize[];
}) {
  const bodyBytes =
    byteLength(input.subject) +
    byteLength(input.bodyText) +
    byteLength(input.bodyHtml);

  let estimatedBytes =
    MIME_FIXED_OVERHEAD_BYTES +
    base64EncodedSize(bodyBytes) +
    input.attachments.reduce(
      (total, attachment) => total + base64EncodedSize(attachment.size) + 2048,
      0
    );

  const linked = new Set<string>();

  if (estimatedBytes <= EMAIL_SERVICE_MAX_BYTES) return linked;

  for (const attachment of [...input.attachments].sort(
    (left, right) => right.size - left.size
  )) {
    linked.add(attachment.id);
    estimatedBytes -= base64EncodedSize(attachment.size) + 2048;

    if (estimatedBytes <= EMAIL_SERVICE_MAX_BYTES) break;
  }

  return linked;
}

export function baseSubject(subject: string) {
  return subject.replaceAll(/^(?:(?:re|fwd):\s*)+/giu, "");
}

export function replySubject(subject: string) {
  return `Re: ${baseSubject(subject)}`;
}

export function forwardSubject(subject: string) {
  return `Fwd: ${baseSubject(subject)}`;
}
