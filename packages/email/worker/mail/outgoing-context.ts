import {
  forwardSubject,
  MAX_MAIL_RECIPIENTS,
  replySubject,
} from "../../shared/mail";
import type { ReplyActionMode } from "../../shared/mail";
import { mailboxStub } from "../mailbox";
import type { Email } from "../mailbox/schema";
import {
  hasNewRecipients,
  shouldDetachOutboundReply,
} from "./outbound-threading";
import { dedupeRecipientFields, recipientCount } from "./recipients";
import type { RecipientFields } from "./recipients";
import { buildReplyPlan, canReplyFrom } from "./reply-plan";

type OutgoingContextCode = "BAD_REQUEST" | "NOT_FOUND" | "NOT_READY";

export class OutgoingContextError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: OutgoingContextCode,
    message: string
  ) {
    super(message);
  }
}

export async function resolveForwardContext(input: {
  env: Env;
  mailboxId: string;
  sourceEmailId: string;
}) {
  const source = await mailboxStub(input.env, input.mailboxId).getEmail(
    input.sourceEmailId
  );

  if (!source) {
    throw new OutgoingContextError(
      404,
      "NOT_FOUND",
      "Forwarded message was not found"
    );
  }

  return {
    source,
    subject: forwardSubject(source.subject),
  };
}

export async function resolveReplyContext(input: {
  env: Env;
  mailboxId: string;
  ownAddress: string;
  sourceEmailId: string;
  mode: ReplyActionMode;
  cc?: string[];
  bcc: string[];
}): Promise<{
  source: Email;
  recipients: RecipientFields;
  subject: string;
  detached: boolean;
  includeRelatedContext: boolean;
}> {
  const stub = mailboxStub(input.env, input.mailboxId);
  const source = await stub.getEmail(input.sourceEmailId);

  if (!source) {
    throw new OutgoingContextError(
      404,
      "NOT_FOUND",
      "Reply source was not found"
    );
  }

  if (!canReplyFrom(source)) {
    throw new OutgoingContextError(
      409,
      "NOT_READY",
      "Wait until the parent message has a confirmed Message-ID"
    );
  }

  const plan = buildReplyPlan(input.ownAddress, source);

  const action = plan.actions.find(
    (candidate) => candidate.mode === input.mode
  );

  if (!action) {
    throw new OutgoingContextError(
      400,
      "BAD_REQUEST",
      "Reply mode is not available"
    );
  }

  const recipients = dedupeRecipientFields({
    to: action.to,
    cc: input.cc ?? action.cc,
    bcc: input.bcc,
  });

  if (recipientCount(recipients) > MAX_MAIL_RECIPIENTS) {
    throw new OutgoingContextError(
      400,
      "BAD_REQUEST",
      `An email can have at most ${MAX_MAIL_RECIPIENTS} recipients across To, Cc, and Bcc`
    );
  }

  const history = await stub.getConversation(source.conversationId);

  return {
    source,
    recipients,
    subject: replySubject(source.subject),
    detached: shouldDetachOutboundReply({
      ownAddress: input.ownAddress,
      plan,
      to: recipients.to,
      cc: recipients.cc,
    }),
    includeRelatedContext: hasNewRecipients({
      ownAddress: input.ownAddress,
      history,
      ...recipients,
    }),
  };
}
