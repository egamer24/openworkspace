import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReplyActionMode } from "../../shared/mail";
import {
  ApiError,
  api,
  responseJson,
  type SuccessfulResponse,
} from "@/lib/api";
import type { SubmittedComposerUpload } from "./composer-session";
import { scheduleMailboxRefresh } from "./mail-query-cache";

export type SubmittedMessage = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.messages.$post>>
>;

type MessageContent = {
  requestId: string;
  mailboxId: string;
  bodyText: string;
  bodyHtml?: string;
  uploadedAttachments?: SubmittedComposerUpload[];
  /** The server deletes this draft once the message is accepted. */
  draftId?: string;
};

export type MailSendInput =
  | MessageContent & {
    kind: "compose";
    to: string[];
    cc: string[];
    bcc: string[];
    replyTo?: string;
    subject: string;
  }
  | MessageContent & {
    kind: "reply";
    parentEmailId: string;
    mode: ReplyActionMode;
    cc: string[];
    bcc: string[];
  }
  | MessageContent & {
    kind: "forward";
    sourceEmailId: string;
    to: string[];
    cc: string[];
    bcc: string[];
    replyTo?: string;
  };

type WithoutRequestId<Input> = Input extends MailSendInput
  ? Omit<Input, "requestId">
  : never;

export type MailSendDraft = WithoutRequestId<MailSendInput>;

export function withMailSendRequestId(
  draft: MailSendDraft,
  requestId: string,
): MailSendInput {
  switch (draft.kind) {
    case "compose":
      return { ...draft, requestId };
    case "reply":
      return { ...draft, requestId };
    case "forward":
      return { ...draft, requestId };
  }
}

export function useMailSend() {
  const client = useQueryClient();

  const send = useMutation({
    mutationFn: async (input: MailSendInput) => {
      const request = {
        requestId: input.requestId,
        mailboxId: input.mailboxId,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml,
        attachments: input.uploadedAttachments ?? [],
        draftId: input.draftId,
      };
      if (input.kind === "reply") {
        return responseJson(
          await api.api.mail.messages[":id"].replies.$post({
            param: { id: input.parentEmailId },
            json: {
              ...request,
              mode: input.mode,
              cc: input.cc,
              bcc: input.bcc,
            },
          }),
        );
      }
      if (input.kind === "forward") {
        return responseJson(
          await api.api.mail.messages[":id"].forward.$post({
            param: { id: input.sourceEmailId },
            json: {
              ...request,
              to: input.to,
              cc: input.cc,
              bcc: input.bcc,
              replyTo: input.replyTo,
            },
          }),
        );
      }
      return responseJson(
        await api.api.mail.messages.$post({
          json: {
            ...request,
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            replyTo: input.replyTo,
            subject: input.subject,
          },
        }),
      );
    },
    // A retry reuses the caller-owned requestId. The Worker derives the
    // message id from it, so a lost response cannot create a second message.
    retry: (failureCount, error) =>
      failureCount < 1
      && (!(error instanceof ApiError) || error.status >= 500),
    onSuccess: (_result, input) => {
      scheduleMailboxRefresh(client, input.mailboxId);
    },
  });

  return { send };
}
