import { describe, expect, it } from "bun:test";

import { buildReplyPlan } from "@open-workspace/email/worker/mail/reply-plan.ts";
import type { MailAddress } from "@open-workspace/email/worker/mailbox/model.ts";

const address = (value: string): MailAddress => ({
  address: value,
  name: null,
});

function incoming(
  overrides: Partial<Parameters<typeof buildReplyPlan>[1]> = {}
) {
  return {
    direction: "incoming" as const,
    messageIdHeader: "<incoming@example.net>",
    transportState: "received" as const,
    fromJson: [address("sender@example.net")],
    replyToJson: [],
    toJson: [address("me@example.test")],
    ccJson: [],
    listId: null,
    listPostAddress: null,
    ...overrides,
  };
}

describe("reply plans", () => {
  it("defaults a group message to Reply all and keeps a direct reply private", () => {
    const plan = buildReplyPlan(
      "me@example.test",
      incoming({
        replyToJson: [
          address("replies@example.net"),
          address("assistant@example.net"),
        ],
        ccJson: [address("colleague@example.net")],
      })
    );

    expect(plan.defaultMode).toBe("reply_all");
    expect(plan.actions).toEqual([
      {
        mode: "reply",
        label: "Reply",
        to: ["replies@example.net", "assistant@example.net"],
        cc: [],
      },
      {
        mode: "reply_all",
        label: "Reply all",
        to: ["replies@example.net", "assistant@example.net"],
        cc: ["colleague@example.net"],
      },
    ]);
  });

  it("continues an outgoing message with visible recipients only", () => {
    const plan = buildReplyPlan("me@example.test", {
      ...incoming(),
      direction: "outgoing",
      messageIdHeader: "<outgoing@example.test>",
      transportState: "submitted",
      fromJson: [address("me@example.test")],
      toJson: [address("friend@example.net")],
      ccJson: [address("team@example.net"), address("me@example.test")],
    });

    expect(plan.actions[0]).toMatchObject({
      mode: "continue",
      to: ["friend@example.net"],
      cc: ["team@example.net"],
    });
  });

  it("does not continue an outgoing message until the provider assigns Message-ID", () => {
    const plan = buildReplyPlan("me@example.test", {
      ...incoming(),
      direction: "outgoing",
      messageIdHeader: null,
      transportState: "unconfirmed",
      fromJson: [address("me@example.test")],
      toJson: [address("friend@example.net")],
    });

    expect(plan.actions).toEqual([]);
  });

  it("offers List-Post as an explicit mailing-list action", () => {
    const plan = buildReplyPlan(
      "me@example.test",
      incoming({
        listId: "workers-list.example.net",
        replyToJson: [address("workers-list@example.net")],
        listPostAddress: "workers-list@example.net",
      })
    );

    expect(plan.defaultMode).toBe("reply_list");
    expect(plan.actions[0]).toMatchObject({
      mode: "reply",
      to: ["sender@example.net"],
    });
    expect(plan.actions).toContainEqual({
      mode: "reply_list",
      label: "Reply to list",
      to: ["workers-list@example.net"],
      cc: [],
    });
  });

  it("defaults an undisclosed recipient to a private reply", () => {
    const plan = buildReplyPlan(
      "hidden@example.test",
      incoming({
        toJson: [address("alice@example.net")],
        ccJson: [address("bob@example.net")],
      })
    );

    expect(plan).toMatchObject({
      defaultMode: "reply",
      isGroup: false,
      participants: ["sender@example.net"],
    });
    expect(plan.actions).toContainEqual({
      mode: "reply_all",
      label: "Reply all",
      to: ["sender@example.net"],
      cc: ["alice@example.net", "bob@example.net"],
    });
  });
});
