import type { FormEvent, RefObject } from "react";

import type { ComposerContent, ComposerEditorHandle } from "./composer-editor";
import type { ValidatedComposerRecipients } from "./composer-recipients";
import { isUploadedAsset } from "./composer-session";
import type {
  ComposerAsset,
  ComposerSession,
  ComposerSessionPhase,
} from "./composer-session";
import { notifyOutboundResult } from "./outbound-notification";
import type { Mailbox, MessageDetail } from "./types";
import { resolveComposerAttachmentPlan } from "./use-composer-attachment-preflight";
import type { PreflightContext } from "./use-composer-attachment-preflight";
import { useComposerSubmission } from "./use-composer-submission";
import type { PreparedComposerSubmission } from "./use-composer-submission";
import type { MailSendDraft } from "./use-mail-send";

type ForwardedComposeMessage = Pick<MessageDetail, "id">;

type ComposeSubmissionInput = {
  session: ComposerSession;
  phase: ComposerSessionPhase;
  mailbox: Mailbox;
  forwardedMessage?: ForwardedComposeMessage;
  recipients: ValidatedComposerRecipients;
  subject: string;
  content: ComposerContent;
  editor: RefObject<ComposerEditorHandle | null>;
  activeAssets: readonly ComposerAsset[];
  uploadLimitError: string | null;
  uploadsPending: boolean;
  uploadsFailed: boolean;
  draftId: string;
  onClose: () => void;
};

export function useComposeSubmission(input: ComposeSubmissionInput) {
  const submission = useComposerSubmission({
    session: input.session,
    phase: input.phase,
    validate: () => submissionValidationError(input),
    prepare: (signal) => prepareComposeSubmission(input, signal),
    failureLabel: "Could not send message",
    onSuccess: (result) => {
      notifyOutboundResult(result, "message");
      input.onClose();
    },
  });

  return {
    busy: submission.busy,
    submit: (event: FormEvent) => {
      event.preventDefault();
      void submission.submit();
    },
  };
}

async function prepareComposeSubmission(
  input: ComposeSubmissionInput,
  signal: AbortSignal
): Promise<PreparedComposerSubmission> {
  let content = input.editor.current?.content() ?? input.content;

  if (!input.forwardedMessage && !hasAuthoredContent(content)) {
    throw new Error("Add text to the message before sending");
  }

  const activeIds = new Set(
    input.editor.current?.assetIds() ??
      input.activeAssets.map((asset) => asset.id)
  );

  const assets = input.session
    .getSnapshot()
    .assets.filter((asset) => activeIds.has(asset.id));

  if (assets.length) {
    await resolveComposerAttachmentPlan(
      input.session,
      preflightContext(input, content),
      assets,
      signal
    );
    // Freeze exactly the same link-card projection that final preflight chose.
    input.editor.current?.reconcileAssets();
    content = input.editor.current?.content() ?? content;
  }

  if (!input.forwardedMessage && !hasAuthoredContent(content)) {
    throw new Error("Add text to the message before sending");
  }

  const finalActiveIds = new Set(
    input.editor.current?.assetIds() ?? [...activeIds]
  );

  const linkedDocumentAssetIds = new Set(content.linkedAssetIds);

  const submittedAssets = input.session
    .getSnapshot()
    .assets.filter(isUploadedAsset)
    .filter((asset) => finalActiveIds.has(asset.id));

  const uploadedAttachments = submittedAssets.map((asset) => {
    const linkedInline =
      asset.intent === "inline" && linkedDocumentAssetIds.has(asset.id);

    return {
      uploadId: asset.uploadId,
      disposition: linkedInline ? ("attachment" as const) : asset.intent,
      // A linked inline image goes as a plain attachment, without its content
      // ID; JSON leaves an undefined one out.
      contentId: (!linkedInline && asset.contentId) || undefined,
    };
  });

  const common = {
    mailboxId: input.mailbox.id,
    bodyText: content.bodyText,
    bodyHtml:
      content.bodyText.trim() ||
      content.inlineAssetIds.length ||
      content.linkedAssetIds.length ||
      content.storedImages.length
        ? content.bodyHtml
        : undefined,
    uploadedAttachments,
    storedImages: content.storedImages,
    draftId: input.draftId,
  };

  const command: MailSendDraft = input.forwardedMessage
    ? {
        ...common,
        kind: "forward",
        sourceEmailId: input.forwardedMessage.id,
        to: input.recipients.to,
        cc: input.recipients.cc,
        bcc: input.recipients.bcc,
        replyTo: input.recipients.replyTo,
      }
    : {
        ...common,
        kind: "compose",
        to: input.recipients.to,
        cc: input.recipients.cc,
        bcc: input.recipients.bcc,
        replyTo: input.recipients.replyTo,
        subject: input.subject,
      };

  return {
    assetIds: submittedAssets.map((asset) => asset.id),
    command,
    submissionKey: JSON.stringify(command),
  };
}

function submissionValidationError(input: ComposeSubmissionInput) {
  if (input.recipients.error) return input.recipients.error;

  if (input.recipients.count === 0) {
    return "Add at least one recipient in To, Cc, or Bcc";
  }

  if (input.uploadLimitError) return input.uploadLimitError;

  if (input.uploadsPending) {
    return "Wait for attachments to finish uploading";
  }

  if (input.uploadsFailed) return "Retry or remove failed attachments";

  if (!input.mailbox.canSend) return "This mailbox is read-only";
  const content = input.editor.current?.content() ?? input.content;

  if (!input.forwardedMessage && !hasAuthoredContent(content)) {
    return "Add text to the message before sending";
  }

  return null;
}

function hasAuthoredContent(content: ComposerContent) {
  return Boolean(
    content.bodyText.trim() ||
    content.inlineAssetIds.length ||
    content.storedImages.length
  );
}

function preflightContext(
  input: Pick<
    ComposeSubmissionInput,
    "forwardedMessage" | "mailbox" | "subject"
  >,
  content: ComposerContent
): PreflightContext {
  return input.forwardedMessage
    ? {
        kind: "forward",
        mailboxId: input.mailbox.id,
        sourceEmailId: input.forwardedMessage.id,
        bodyText: content.bodyText,
        bodyHtml: content.bodyHtml || undefined,
      }
    : {
        kind: "compose",
        mailboxId: input.mailbox.id,
        subject: input.subject,
        bodyText: content.bodyText,
        bodyHtml: content.bodyHtml || undefined,
      };
}
