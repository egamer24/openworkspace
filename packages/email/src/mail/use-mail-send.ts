import { ApiError, responseJson } from "@open-workspace/core/ui";
import type { SuccessfulResponse } from "@open-workspace/core/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ReplyActionMode } from "../../shared/mail";
import type { StoredImageRef } from "../../shared/rich-content";
import { mailApi } from "../lib/mail-api";
import type { SubmittedComposerUpload } from "./composer-session";
import { scheduleMailboxRefresh } from "./mail-query-cache";

export type SubmittedMessage = SuccessfulResponse<
  Awaited<ReturnType<typeof mailApi.api.mail.messages.$post>>
>;

type MessageContent = {
  requestId: string;
  mailboxId: string;
  bodyText: string;
  bodyHtml?: string;
  uploadedAttachments?: SubmittedComposerUpload[];
  /** Saved images the body shows by `cid:`, e.g. the signature's. */
  storedImages?: StoredImageRef[];
};

type MailSendInput =
  | (MessageContent & {
      kind: "compose";
      to: string[];
      cc: string[];
      bcc: string[];
      replyTo?: string;
      subject: string;
    })
  | (MessageContent & {
      kind: "reply";
      parentEmailId: string;
      mode: ReplyActionMode;
      cc: string[];
      bcc: string[];
    })
  | (MessageContent & {
      kind: "forward";
      sourceEmailId: string;
      to: string[];
      cc: string[];
      bcc: string[];
      replyTo?: string;
    });

type WithoutRequestId<Input> = Input extends MailSendInput
  ? Omit<Input, "requestId">
  : never;

export type MailSendDraft = WithoutRequestId<MailSendInput>;

export function withMailSendRequestId(
  draft: MailSendDraft,
  requestId: string
): MailSendInput {
  switch (draft.kind) {
    case "compose": {
      return { ...draft, requestId };
    }

    case "reply": {
      return { ...draft, requestId };
    }

    case "forward": {
      return { ...draft, requestId };
    }

    default: {
      const unexpected: never = draft;
      throw new Error(`Unknown send kind: ${JSON.stringify(unexpected)}`);
    }
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
        storedImages: input.storedImages ?? [],
      };

      if (input.kind === "reply") {
        return responseJson(
          await mailApi.api.mail.messages[":id"].replies.$post({
            param: { id: input.parentEmailId },
            json: {
              ...request,
              mode: input.mode,
              cc: input.cc,
              bcc: input.bcc,
            },
          })
        );
      }

      if (input.kind === "forward") {
        return responseJson(
          await mailApi.api.mail.messages[":id"].forward.$post({
            param: { id: input.sourceEmailId },
            json: {
              ...request,
              to: input.to,
              cc: input.cc,
              bcc: input.bcc,
              replyTo: input.replyTo,
            },
          })
        );
      }

      return responseJson(
        await mailApi.api.mail.messages.$post({
          json: {
            ...request,
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            replyTo: input.replyTo,
            subject: input.subject,
          },
        })
      );
    },
    // A retry reuses the caller-owned requestId. The Worker derives the
    // message id from it, so a lost response cannot create a second message.
    retry: (failureCount, error) =>
      failureCount < 1 && (!(error instanceof ApiError) || error.status >= 500),
    onSuccess: (_result, input) => {
      scheduleMailboxRefresh(client, input.mailboxId);
    },
  });

  return { send };
}
