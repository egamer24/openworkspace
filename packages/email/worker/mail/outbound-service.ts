import {
  deferWebhookTask,
  queueWebhookEvent,
} from "@open-workspace/core/module";

import {
  EMAIL_SENT_EVENT,
  EMAIL_WEBHOOK_SOURCE,
  emailWebhookEventId,
} from "../../shared/webhooks";
import { mailboxStub } from "../mailbox";
import type { Email } from "../mailbox/schema";
import {
  discardPreparedObjects,
  messageIdForRequest,
  outgoingRequestFingerprint,
  prepareOutgoingEmail,
} from "./outbound";
import type { OutgoingMessageInput } from "./outbound";
import { discardComposerUploads } from "./uploads";

export class OutgoingRequestConflictError extends Error {}

function deferComposerUploadCleanup(input: {
  env: Env;
  compose: OutgoingMessageInput;
  uploadIds: string[];
  defer: (task: Promise<unknown>) => void;
}) {
  const uploadIds = [...new Set(input.uploadIds)];

  if (!uploadIds.length) return;
  input.defer(
    discardComposerUploads({
      env: input.env,
      mailboxId: input.compose.mailboxId,
      userId: input.compose.userId,
      uploadIds,
    })
  );
}

export function deferEmailSentWebhook(input: {
  env: Env;
  mailboxId: string;
  email: Pick<Email, "id" | "timelineAt" | "transportState">;
  defer: (task: Promise<unknown>) => void;
}) {
  if (input.email.transportState !== "submitted") return;
  deferWebhookTask(input.defer, () =>
    queueWebhookEvent(input.env, {
      eventId: emailWebhookEventId(
        EMAIL_SENT_EVENT,
        input.mailboxId,
        input.email.id
      ),
      eventType: EMAIL_SENT_EVENT,
      occurredAt: input.email.timelineAt.getTime(),
      source: {
        kind: EMAIL_WEBHOOK_SOURCE,
        mailboxId: input.mailboxId,
        messageId: input.email.id,
      },
    })
  );
}

export async function submitOutgoing(input: {
  env: Env;
  requestUrl: string;
  fromAddress: string;
  fromName: string;
  compose: OutgoingMessageInput;
  conversationId: string;
  related: Email | null;
  forwarded: Email | null;
  includeRelatedContext: boolean;
  defer: (task: Promise<unknown>) => void;
}) {
  const { compose } = input;
  const stub = mailboxStub(input.env, compose.mailboxId);
  const id = await messageIdForRequest(compose.mailboxId, compose.requestId);
  const requestFingerprint = await outgoingRequestFingerprint(compose);
  const existing = await stub.getEmail(id);

  if (existing) {
    if (
      existing.direction !== "outgoing" ||
      existing.requestFingerprint !== requestFingerprint
    ) {
      // The conflicting request was not accepted, so its composer still owns
      // these immutable uploads and may retry them with a fresh attempt id.
      throw new OutgoingRequestConflictError(
        "Request identifier is already in use with different content"
      );
    }

    deferComposerUploadCleanup({
      ...input,
      uploadIds: compose.attachments.map((attachment) => attachment.uploadId),
    });
    deferEmailSentWebhook({
      env: input.env,
      mailboxId: compose.mailboxId,
      email: existing,
      defer: input.defer,
    });

    return { email: existing, inserted: false };
  }

  const prepared = await prepareOutgoingEmail({
    env: input.env,
    requestUrl: input.requestUrl,
    compose,
    requestFingerprint,
    id,
    conversationId: input.conversationId,
    related: input.related,
    forwarded: input.forwarded,
    includeRelatedContext: input.includeRelatedContext,
    fromAddress: input.fromAddress,
    fromName: input.fromName,
    now: new Date(),
  });

  let submission: Awaited<ReturnType<typeof stub.submitOutgoing>>;

  try {
    submission = await stub.submitOutgoing(prepared.email);
  } catch (error) {
    await discardPreparedObjects(input.env, prepared.storageKeys);
    throw error;
  }

  if (submission.outcome !== "inserted") {
    await discardPreparedObjects(input.env, prepared.storageKeys);

    if (submission.outcome === "conflict") {
      // Do not clean the losing request's composer uploads. Only prepared
      // message-scoped copies belong to this failed submission attempt.
      throw new OutgoingRequestConflictError(
        "Request identifier is already in use with different content"
      );
    }
  }

  deferComposerUploadCleanup({
    ...input,
    uploadIds: prepared.composerUploadIds,
  });
  deferEmailSentWebhook({
    env: input.env,
    mailboxId: compose.mailboxId,
    email: submission.email,
    defer: input.defer,
  });

  return {
    email: submission.email,
    inserted: submission.outcome === "inserted",
  };
}
