import {
  normalizeEmail,
  normalizeMailboxAddress,
} from "@open-workspace/core/module";

import type { ReplyAction, ReplyPlan } from "../../shared/mail";
import type { MailAddress } from "../mailbox/model";
import type { Email } from "../mailbox/schema";
import { uniqueParticipantAddresses } from "./participants";

export type {
  ReplyAction,
  ReplyActionMode,
  ReplyPlan,
} from "../../shared/mail";

function uniqueAddresses(values: MailAddress[], ownAddress: string) {
  return uniqueParticipantAddresses(values, ownAddress);
}

function without(values: string[], excluded: string[]) {
  const blocked = new Set(excluded.map(normalizeEmail));

  return values.filter((value) => !blocked.has(normalizeEmail(value)));
}

type ReplySource = Pick<
  Email,
  | "direction"
  | "messageIdHeader"
  | "transportState"
  | "fromJson"
  | "replyToJson"
  | "toJson"
  | "ccJson"
  | "listId"
  | "listPostAddress"
>;

export function canReplyFrom(
  email: Pick<ReplySource, "direction" | "messageIdHeader" | "transportState">
) {
  if (email.direction === "incoming") return true;

  return Boolean(email.messageIdHeader) && email.transportState === "submitted";
}

export function buildReplyPlan(
  ownAddress: string,
  email: ReplySource
): ReplyPlan {
  if (email.direction === "outgoing") {
    const to = uniqueAddresses(email.toJson, ownAddress);
    const cc = without(uniqueAddresses(email.ccJson, ownAddress), to);
    const participants = [...to, ...cc];

    return {
      defaultMode: "continue",
      isGroup: participants.length > 1,
      participants,
      actions: canReplyFrom(email)
        ? [
            {
              mode: "continue",
              label: "Continue",
              to,
              cc,
            },
          ]
        : [],
    };
  }

  // List managers commonly rewrite Reply-To to the list itself. A private
  // reply must still target the actual author; List-Post is handled separately.
  const replyTargets = uniqueAddresses(
    email.listId
      ? email.fromJson
      : email.replyToJson.length
        ? email.replyToJson
        : email.fromJson,
    ownAddress
  );

  const visibleParticipants = uniqueAddresses(
    [...email.fromJson, ...email.toJson, ...email.ccJson],
    ownAddress
  );

  const replyAllParticipants = uniqueAddresses(
    [
      ...(email.listId
        ? email.fromJson
        : email.replyToJson.length
          ? email.replyToJson
          : email.fromJson),
      ...email.toJson,
      ...email.ccJson,
    ],
    ownAddress
  );

  const visibleIsGroup =
    Boolean(email.listId) || replyAllParticipants.length > 1;

  const own = normalizeMailboxAddress(ownAddress);

  const visibleRecipients = [...email.toJson, ...email.ccJson].some(
    (recipient) => normalizeMailboxAddress(recipient.address) === own
  );

  const undisclosedLocalRecipient = !email.listId && !visibleRecipients;
  const isGroup = visibleIsGroup && !undisclosedLocalRecipient;

  const actions: ReplyAction[] = [
    {
      mode: "reply",
      label: "Reply",
      to: replyTargets,
      cc: [],
    },
  ];

  const listTargets = uniqueAddresses(
    email.listPostAddress
      ? [{ address: email.listPostAddress, name: null }]
      : [],
    ownAddress
  ).slice(0, 1);

  if (!email.listId && visibleIsGroup) {
    actions.push({
      mode: "reply_all",
      label: "Reply all",
      to: replyTargets,
      cc: without(replyAllParticipants, replyTargets),
    });
  }

  if (email.listId && listTargets.length) {
    actions.push({
      mode: "reply_list",
      label: "Reply to list",
      to: listTargets,
      cc: [],
    });
  }

  return {
    defaultMode: listTargets.length
      ? "reply_list"
      : email.listId
        ? "reply"
        : undisclosedLocalRecipient
          ? "reply"
          : isGroup
            ? "reply_all"
            : "reply",
    isGroup,
    participants: undisclosedLocalRecipient
      ? replyTargets
      : visibleParticipants,
    actions,
  };
}

/**
 * The alias a reply comes from: the one the source was delivered to, or
 * sent from; null to use the mailbox's own address.
 */
export function replyAlias<Alias extends { address: string }>(
  source: Pick<Email, "direction" | "envelopeTo" | "fromJson">,
  aliases: readonly Alias[]
) {
  const address =
    source.direction === "incoming"
      ? source.envelopeTo
      : (source.fromJson[0]?.address ?? null);

  if (!address) return null;
  const normalized = normalizeMailboxAddress(address);

  return aliases.find((alias) => alias.address === normalized) ?? null;
}
