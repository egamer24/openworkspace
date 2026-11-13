import type { ValidatedComposerRecipients } from "./composer-recipients";
import { isUploadedAsset } from "./composer-session";
import type { ComposerSession, ComposerSessionPhase } from "./composer-session";
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
  body: string;
  uploadLimitError: string | null;
  uploadsPending: boolean;
  uploadsFailed: boolean;
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

  if (!input.body.trim()) return "Add text to the reply before sending";

  return null;
}

async function prepareReplySubmission(
  input: ReplySubmissionInput,
  signal: AbortSignal
): Promise<PreparedComposerSubmission> {
  if (!input.mailbox || !input.action) {
    throw new Error("Reply is no longer available");
  }

  const submittedAssets = input.session
    .getSnapshot()
    .assets.filter(isUploadedAsset);

  if (submittedAssets.length) {
    await resolveComposerAttachmentPlan(
      input.session,
      {
        kind: "reply",
        mailboxId: input.mailbox.id,
        sourceEmailId: input.parent.id,
        mode: input.action.mode,
        cc: input.recipients.cc,
        bcc: input.recipients.bcc,
        bodyText: input.body,
      },
      submittedAssets,
      signal
    );
  }

  const uploadedAttachments = submittedAssets.map((asset) => ({
    uploadId: asset.uploadId,
    disposition: "attachment" as const,
  }));

  const command: MailSendDraft = {
    kind: "reply",
    mailboxId: input.mailbox.id,
    cc: input.recipients.cc,
    bcc: input.recipients.bcc,
    bodyText: input.body,
    uploadedAttachments,
    parentEmailId: input.parent.id,
    mode: input.action.mode,
  };

  return {
    assetIds: submittedAssets.map((asset) => asset.id),
    command,
    submissionKey: JSON.stringify(command),
  };
}
