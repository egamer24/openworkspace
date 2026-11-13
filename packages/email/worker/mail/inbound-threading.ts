import { normalizeEmail } from "@open-workspace/core/module";

import type { MailAddress } from "../mailbox/model";
import type { Email } from "../mailbox/schema";
import { normalizedParticipantSet } from "./participants";

type ThreadParent = Pick<
  Email,
  "listId" | "fromJson" | "toJson" | "ccJson" | "bccJson"
>;

/**
 * RFC references still point at the source message, but a private answer to a
 * visible group belongs to a separate local chat in the messenger model.
 */
export function shouldDetachInboundReply(input: {
  ownAddress: string;
  parent: ThreadParent;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  listId: string | null;
}) {
  const { parent } = input;
  const normalizedListId = input.listId?.trim().toLocaleLowerCase() ?? null;
  const parentListId = parent.listId?.trim().toLocaleLowerCase() ?? null;

  if (parent.listId && parentListId !== normalizedListId) return true;

  const parentParticipants = normalizedParticipantSet(
    [...parent.fromJson, ...parent.toJson, ...parent.ccJson].map(
      (participant) => participant.address
    ),
    input.ownAddress
  );

  const incomingParticipants = normalizedParticipantSet(
    [...input.from, ...input.to, ...input.cc].map(
      (participant) => participant.address
    ),
    input.ownAddress
  );

  const parentWasGroup = Boolean(parent.listId) || parentParticipants.size > 1;

  const incomingIsDirect =
    input.listId === null && incomingParticipants.size === 1;

  if (parentWasGroup && incomingIsDirect) return true;

  const hiddenRecipients = new Set(
    parent.bccJson.map((recipient) => normalizeEmail(recipient.address))
  );

  return input.from.some((sender) =>
    hiddenRecipients.has(normalizeEmail(sender.address))
  );
}
