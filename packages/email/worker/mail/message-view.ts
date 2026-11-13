import type { SenderStatus, Unsubscription } from "../../shared/mail-feedback";
import type { Email } from "../mailbox/schema";
import { workspaceBlockFor } from "../mailbox/senders";
import { headerAuthentication } from "./header-metadata";
import { messageSecurity } from "./message-security";
import type { SenderHistory } from "./message-security";
import type { WorkspaceIdentity } from "./security-settings";
import { storedSenderIntel } from "./sender-intel";
import { unsubscribeListKey } from "./unsubscribe";

export type MessageSafetyContext = {
  senders: Record<string, SenderStatus>;
  unsubscriptions: Record<string, Unsubscription>;
  workspaceBlocks: ReadonlyMap<string, number>;
};

const emptySafetyContext: MessageSafetyContext = {
  senders: {},
  unsubscriptions: {},
  workspaceBlocks: new Map(),
};

/** Block, trust and report state for the sender, with workspace blocks taking precedence. */
export function senderStatus(
  email: Email,
  safety: MessageSafetyContext
): SenderStatus | null {
  if (email.direction !== "incoming") return null;
  const address = email.fromJson[0]?.address.toLocaleLowerCase() ?? "";
  const local = safety.senders[address];

  return {
    block:
      workspaceBlockFor(address, safety.workspaceBlocks) ??
      local?.block ??
      null,
    trustedAt: local?.trustedAt ?? null,
    reportedAt: local?.reportedAt ?? null,
  };
}

export function emailListKey(email: Email) {
  return email.direction === "incoming"
    ? unsubscribeListKey({
        listId: email.listId,
        fromAddress: email.fromJson[0]?.address ?? null,
      })
    : null;
}

export function emailSecurity(
  email: Email,
  identity: WorkspaceIdentity,
  history: Record<string, SenderHistory>,
  safety: MessageSafetyContext = emptySafetyContext
) {
  if (email.direction !== "incoming") return null;
  const from = email.fromJson[0] ?? { address: "", name: null };
  const status = senderStatus(email, safety);

  return messageSecurity({
    fromAddress: from.address,
    fromName: from.name,
    authentication: headerAuthentication(email),
    listUnsubscribe: email.listUnsubscribeJson ?? null,
    workspaceDomains: identity.domains,
    internalNames: identity.names,
    intel: storedSenderIntel(email.senderIntelJson),
    history: history[from.address.toLocaleLowerCase()] ?? null,
    replyTo: email.replyToJson.map((item) => item.address),
    listId: email.listId,
    delivery: email.deliveryJson ?? null,
    trusted: Boolean(status?.trustedAt) && !status?.block,
  });
}
