import {
  normalizeEmail,
  normalizeMailboxAddress,
} from "@open-workspace/core/module";

import type { MailAddress } from "../mailbox/model";

export type ParticipantSource = {
  fromJson: MailAddress[];
  toJson: MailAddress[];
  ccJson: MailAddress[];
  bccJson: MailAddress[];
};

export type ParticipantSuggestion = {
  address: string;
  name: string | null;
};

export function normalizedParticipantSet(
  values: Iterable<string>,
  ownAddress: string
) {
  const own = normalizeMailboxAddress(ownAddress);
  const result = new Set<string>();

  for (const value of values) {
    const normalized = normalizeEmail(value);

    if (normalized && normalizeMailboxAddress(normalized) !== own) {
      result.add(normalized);
    }
  }

  return result;
}

export function uniqueParticipantAddresses(
  values: Iterable<MailAddress>,
  ownAddress: string
) {
  return [
    ...normalizedParticipantSet(
      Array.from(values, (value) => value.address),
      ownAddress
    ),
  ];
}

export function sameParticipantSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

export function participantLabels(
  values: Iterable<MailAddress>,
  ownAddress: string
) {
  const own = normalizeMailboxAddress(ownAddress);
  const result = new Map<string, string>();

  for (const participant of values) {
    const normalized = normalizeEmail(participant.address);

    if (
      !normalized ||
      normalizeMailboxAddress(normalized) === own ||
      result.has(normalized)
    ) {
      continue;
    }

    result.set(normalized, participant.name?.trim() || participant.address);
  }

  return [...result.values()];
}

export function suggestParticipants(
  messages: Iterable<ParticipantSource>,
  ownAddress: string,
  query: string,
  limit: number,
  /** Blocked or reported correspondents are never suggested. */
  exclude: (address: string) => boolean = () => false
): ParticipantSuggestion[] {
  const own = normalizeMailboxAddress(ownAddress);
  const needle = query.trim().toLocaleLowerCase("en-US");
  const result = new Map<string, ParticipantSuggestion>();

  for (const message of messages) {
    for (const participant of [
      ...message.fromJson,
      ...message.toJson,
      ...message.ccJson,
      ...message.bccJson,
    ]) {
      const address = normalizeEmail(participant.address);

      if (
        !address ||
        normalizeMailboxAddress(address) === own ||
        result.has(address) ||
        exclude(address.toLocaleLowerCase("en-US"))
      ) {
        continue;
      }

      const name = participant.name?.trim() || null;

      if (
        needle &&
        !address.toLocaleLowerCase("en-US").includes(needle) &&
        !name?.toLocaleLowerCase("en-US").includes(needle)
      ) {
        continue;
      }

      result.set(address, { address, name });

      if (result.size >= limit) return [...result.values()];
    }
  }

  return [...result.values()];
}
