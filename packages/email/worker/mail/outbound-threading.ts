import type { ReplyPlan } from "../../shared/mail";
import type { Email } from "../mailbox/schema";
import { normalizedParticipantSet, sameParticipantSet } from "./participants";

type ParticipantEmail = Pick<
  Email,
  "fromJson" | "toJson" | "ccJson" | "bccJson" | "listPostAddress"
>;

function normalizedRecipients(values: string[], ownAddress: string) {
  return normalizedParticipantSet(values, ownAddress);
}

/**
 * RFC headers may still reference the source message, but a one-person answer
 * from a visible group is a separate local chat. Matching List-Post is the one
 * intentional single-address exception because that address represents a list.
 */
export function shouldDetachOutboundReply(input: {
  ownAddress: string;
  plan: Pick<ReplyPlan, "isGroup" | "actions">;
  to: string[];
  cc: string[];
}) {
  if (!input.plan.isGroup) return false;

  const actual = normalizedRecipients(
    [...input.to, ...input.cc],
    input.ownAddress
  );

  if (actual.size > 1) return false;

  const listAction = input.plan.actions.find(
    (action) => action.mode === "reply_list"
  );

  const matchesListPost = listAction
    ? sameParticipantSet(
        actual,
        normalizedRecipients(
          [...listAction.to, ...listAction.cc],
          input.ownAddress
        )
      )
    : false;

  return !matchesListPost;
}

function previousParticipants(ownAddress: string, history: ParticipantEmail[]) {
  const values = history
    .flatMap((message) => [
      ...message.fromJson,
      ...message.toJson,
      ...message.ccJson,
      ...message.bccJson,
      ...(message.listPostAddress
        ? [{ address: message.listPostAddress, name: null }]
        : []),
    ])
    .map((item) => item.address);

  return normalizedRecipients(values, ownAddress);
}

export function hasNewRecipients(input: {
  ownAddress: string;
  history: ParticipantEmail[];
  to: string[];
  cc: string[];
  bcc: string[];
}) {
  if (!input.history.length) return false;
  const previous = previousParticipants(input.ownAddress, input.history);

  const next = normalizedRecipients(
    [...input.to, ...input.cc, ...input.bcc],
    input.ownAddress
  );

  return [...next].some((recipient) => !previous.has(recipient));
}
