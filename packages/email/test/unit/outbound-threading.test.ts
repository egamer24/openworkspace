import { describe, expect, it } from "bun:test";

import {
  hasNewRecipients,
  shouldDetachOutboundReply,
} from "@open-workspace/email/worker/mail/outbound-threading.ts";
import { buildReplyPlan } from "@open-workspace/email/worker/mail/reply-plan.ts";
import type { MailAddress } from "@open-workspace/email/worker/mailbox/model.ts";

const address = (value: string): MailAddress => ({
  address: value,
  name: null,
});

function groupParent() {
  return {
    direction: "outgoing" as const,
    messageIdHeader: "<parent@example.test>",
    transportState: "submitted" as const,
    fromJson: [address("me@example.test")],
    replyToJson: [],
    toJson: [address("anna@example.net"), address("boris@example.net")],
    ccJson: [],
    bccJson: [],
    listId: null,
    listPostAddress: null,
  };
}

function shouldDetach(
  parent: Parameters<typeof buildReplyPlan>[1],
  to: string[],
  cc: string[]
) {
  const ownAddress = "me@example.test";

  return shouldDetachOutboundReply({
    ownAddress,
    plan: buildReplyPlan(ownAddress, parent),
    to,
    cc,
  });
}

describe("outbound conversation boundaries", () => {
  it("detaches a one-person answer from a group even if sent as parent reply", () => {
    expect(shouldDetach(groupParent(), ["anna@example.net"], [])).toBe(true);
  });

  it("keeps the complete visible group in the same conversation", () => {
    expect(
      shouldDetach(groupParent(), ["anna@example.net"], ["boris@example.net"])
    ).toBe(false);
  });

  it("keeps a single List-Post address in its list conversation", () => {
    expect(
      shouldDetach(
        {
          ...groupParent(),
          direction: "incoming",
          transportState: "received",
          fromJson: [address("author@example.net")],
          toJson: [address("me@example.test")],
          listId: "list.example.net",
          listPostAddress: "list@example.net",
        },
        ["list@example.net"],
        []
      )
    ).toBe(false);
  });

  it("requests quoted context only for a newly introduced recipient", () => {
    const history = [groupParent()];
    expect(
      hasNewRecipients({
        ownAddress: "me@example.test",
        history,
        to: ["anna@example.net"],
        cc: ["boris@example.net"],
        bcc: [],
      })
    ).toBe(false);
    expect(
      hasNewRecipients({
        ownAddress: "me@example.test",
        history,
        to: ["anna@example.net"],
        cc: ["new@example.net"],
        bcc: [],
      })
    ).toBe(true);
  });
});
