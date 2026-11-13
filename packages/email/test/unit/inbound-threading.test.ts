import { describe, expect, it } from "bun:test";

import { shouldDetachInboundReply } from "@open-workspace/email/worker/mail/inbound-threading.ts";
import type { MailAddress } from "@open-workspace/email/worker/mailbox/model.ts";

const address = (value: string): MailAddress => ({
  address: value,
  name: null,
});

function groupParent(
  overrides: Partial<
    Parameters<typeof shouldDetachInboundReply>[0]["parent"]
  > = {}
) {
  return {
    listId: null,
    fromJson: [address("me@example.test")],
    toJson: [address("anna@example.net"), address("boris@example.net")],
    ccJson: [],
    bccJson: [],
    ...overrides,
  };
}

describe("inbound conversation boundaries", () => {
  it("detaches an external private reply from a visible group", () => {
    expect(
      shouldDetachInboundReply({
        ownAddress: "me@example.test",
        parent: groupParent(),
        from: [address("anna@example.net")],
        to: [address("me@example.test")],
        cc: [],
        listId: null,
      })
    ).toBe(true);
  });

  it("keeps an external reply-all in the group conversation", () => {
    expect(
      shouldDetachInboundReply({
        ownAddress: "me@example.test",
        parent: groupParent(),
        from: [address("anna@example.net")],
        to: [address("me@example.test")],
        cc: [address("boris@example.net")],
        listId: null,
      })
    ).toBe(false);
  });

  it("detaches replies from hidden recipients", () => {
    expect(
      shouldDetachInboundReply({
        ownAddress: "me@example.test",
        parent: groupParent({ bccJson: [address("hidden@example.net")] }),
        from: [address("hidden@example.net")],
        to: [address("me@example.test")],
        cc: [],
        listId: null,
      })
    ).toBe(true);
  });

  it("keeps list traffic together but detaches a private list reply", () => {
    const parent = groupParent({ listId: "list.example.net" });

    const base = {
      ownAddress: "me@example.test",
      parent,
      from: [address("member@example.net")],
      to: [address("me@example.test")],
      cc: [],
    };

    expect(
      shouldDetachInboundReply({ ...base, listId: "list.example.net" })
    ).toBe(false);
    expect(shouldDetachInboundReply({ ...base, listId: null })).toBe(true);
  });
});
