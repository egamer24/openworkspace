import type { RefObject } from "react";

import type { ComposerContent, ComposerEditorHandle } from "./composer-editor";
import type { ValidatedComposerRecipients } from "./composer-recipients";
import { isUploadedAsset } from "./composer-session";
import type {
  ComposerAsset,
  ComposerSession,
  ComposerSessionPhase,
} from "./composer-session";
import { notifyOutboundResult } from "./outbound-notification";
import type { Mailbox, MessageDetail, ReplyAction } from "./types";
import { resolveComposerAttachmentPlan } from "./use-composer-attachment-preflight";
import { useComposerSubmission } from "./use-composer-submission";
import type { PreparedComposerSubmission } from "./use-composer-submission";
import type { MailSendDraft, SubmittedMessage } from "./use-mail-send";

export type SentReply = Pick<SubmittedMessage, "conversationId" | "detached">;

type ReplySubmissionInput = {
  session: ComposerSession;
  phase: ComposerSessionPhase;
  mailbox?: Mailbox;
  parent: MessageDetail;
  action?: ReplyAction;
  recipients: ValidatedComposerRecipients;
  editor: RefObject<ComposerEditorHandle | null>;
  /** Attachments, and the inline images still in the editor. */
  activeAssets: readonly ComposerAsset[];
  uploadLimitError: string | null;
  uploadsPending: boolean;
  uploadsFailed: boolean;
  draftId: string;
  onSuccess: (result: SentReply) => void;
};

export function useReplySubmission(input: ReplySubmissionInput) {
  return useComposerSubmission({
    session: input.session,
    phase: input.phase,
    validate: () => replySubmissionValidationError(input),
    prepare: (signal) => prepareReplySubmission(input, signal),
    failureLabel: "Could not send reply",
    onSuccess: (result) => {
      notifyOutboundResult(result, "reply");
      input.onSuccess({
        conversationId: result.conversationId,
        detached: result.detached,
      });
    },
  });
}

function replySubmissionValidationError(input: ReplySubmissionInput) {
  if (!input.mailbox?.canSend || !input.action) {
    return "Reply is no longer available";
  }

  if (input.recipients.error) return input.recipients.error;

  if (input.uploadLimitError) return input.uploadLimitError;

  if (input.uploadsPending) {
    return "Wait for attachments to finish uploading";
  }

  if (input.uploadsFailed) return "Retry or remove failed attachments";

  const content = input.editor.current?.content();

  if (!content || !hasAuthoredContent(content)) {
    return "Add text to the reply before sending";
  }

  return null;
}

async function prepareReplySubmission(
  input: ReplySubmissionInput,
  signal: AbortSignal
): Promise<PreparedComposerSubmission> {
  if (!input.mailbox || !input.action) {
    throw new Error("Reply is no longer available");
  }

  let content = input.editor.current?.content();

  if (!content || !hasAuthoredContent(content)) {
    throw new Error("Add text to the reply before sending");
  }

  const activeIds = new Set(input.activeAssets.map((asset) => asset.id));

  const assets = input.session
    .getSnapshot()
    .assets.filter((asset) => activeIds.has(asset.id));

  if (assets.length) {
    await resolveComposerAttachmentPlan(
      input.session,
      {
        kind: "reply",
        mailboxId: input.mailbox.id,
        sourceEmailId: input.parent.id,
        mode: input.action.mode,
        cc: input.recipients.cc,
        bcc: input.recipients.bcc,
        bodyText: content.bodyText,
        bodyHtml: content.bodyHtml,
      },
      assets,
      signal
    );
    // Freeze the link cards final preflight chose, as the compose window does.
    input.editor.current?.reconcileAssets();
    content = input.editor.current?.content() ?? content;
  }

  const linkedDocumentAssetIds = new Set(content.linkedAssetIds);
  const submittedAssets = assets.filter(isUploadedAsset);

  const uploadedAttachments = submittedAssets.map((asset) => {
    const linkedInline =
      asset.intent === "inline" && linkedDocumentAssetIds.has(asset.id);

    return {
      uploadId: asset.uploadId,
      disposition: linkedInline ? ("attachment" as const) : asset.intent,
      // JSON leaves an undefined content ID out.
      contentId: (!linkedInline && asset.contentId) || undefined,
    };
  });

  const command: MailSendDraft = {
    kind: "reply",
    mailboxId: input.mailbox.id,
    cc: input.recipients.cc,
    bcc: input.recipients.bcc,
    bodyText: content.bodyText,
    bodyHtml: content.bodyHtml,
    uploadedAttachments,
    storedImages: content.storedImages,
    parentEmailId: input.parent.id,
    mode: input.action.mode,
    draftId: input.draftId,
  };

  return {
    assetIds: submittedAssets.map((asset) => asset.id),
    command,
    submissionKey: JSON.stringify(command),
  };
}

function hasAuthoredContent(content: ComposerContent) {
  return Boolean(
    content.bodyText.trim() ||
    content.inlineAssetIds.length ||
    content.storedImages.length
  );
}
