import { describe, expect, it } from "bun:test";

import {
  evaluateRules,
  ruleInputSchema,
  ruleMatches,
} from "@open-workspace/email/worker/mail/rules.ts";
import type {
  RuleInput,
  RuleSubject,
} from "@open-workspace/email/worker/mail/rules.ts";

const message: RuleSubject = {
  fromJson: [{ address: "billing@mail.shop.example", name: "Shop" }],
  toJson: [{ address: "me@example.test", name: null }],
  ccJson: [{ address: "team@example.test", name: null }],
  envelopeTo: "billing+shop@example.test",
  subject: "Your receipt #42",
  listId: "<news.shop.example>",
  attachmentsJson: [],
};

function rule(
  id: string,
  input: Partial<RuleInput>
): RuleInput & { id: string } {
  return {
    id,
    ...ruleInputSchema.parse({
      name: id,
      conditions: [{ type: "subject", op: "contains", value: "receipt" }],
      actions: [{ type: "archive" }],
      ...input,
    }),
  };
}

describe("mailbox rules", () => {
  it("matches sender domains including subdomains, case-insensitively", () => {
    const from = (value: string) =>
      ruleMatches(
        { match: "all", conditions: [{ type: "from", op: "domain", value }] },
        message
      );

    expect(from("shop.example")).toBe(true);
    expect(from("@SHOP.example")).toBe(true);
    expect(from("hop.example")).toBe(false);
  });

  it("matches recipients in To, Cc and the delivered-to address", () => {
    const to = (value: string) =>
      ruleMatches(
        {
          match: "all",
          conditions: [{ type: "recipient", op: "contains", value }],
        },
        message
      );

    expect(to("me@")).toBe(true);
    expect(to("team@")).toBe(true);
    // Bcc'd or forwarded mail names this address only in the envelope.
    expect(to("billing+shop@")).toBe(true);
    expect(to("sales@")).toBe(false);
  });

  it("combines conditions with all or any", () => {
    const conditions = [
      { type: "recipient", op: "equals", value: "TEAM@example.test" },
      { type: "hasAttachment" },
    ] as const;

    expect(
      ruleMatches({ match: "any", conditions: [...conditions] }, message)
    ).toBe(true);
    expect(
      ruleMatches({ match: "all", conditions: [...conditions] }, message)
    ).toBe(false);
    expect(
      ruleMatches(
        {
          match: "all",
          conditions: [{ type: "listId", op: "contains", value: "news.shop" }],
        },
        message
      )
    ).toBe(true);
  });

  it("runs rules in order: later placements win, stop ends the run", () => {
    const outcome = evaluateRules(
      [
        rule("a", { actions: [{ type: "archive" }, { type: "markRead" }] }),
        rule("b", {
          actions: [{ type: "moveToFolder", folderId: "fld_receipts" }],
          stopProcessing: true,
        }),
        rule("c", { actions: [{ type: "trash" }] }),
      ],
      message
    );

    expect(outcome.placement).toEqual({
      type: "folder",
      folderId: "fld_receipts",
    });
    expect(outcome.markRead).toBe(true);
    expect(outcome.matchedRuleIds).toEqual(["a", "b"]);
  });

  it("skips disabled and non-matching rules", () => {
    const outcome = evaluateRules(
      [
        rule("off", { enabled: false, actions: [{ type: "spam" }] }),
        rule("other", {
          conditions: [{ type: "subject", op: "equals", value: "receipt" }],
          actions: [{ type: "trash" }],
        }),
      ],
      message
    );

    expect(outcome.placement).toBeNull();
    expect(outcome.matchedRuleIds).toEqual([]);
  });

  it("allows each action once per rule", () => {
    expect(
      ruleInputSchema.safeParse({
        name: "x",
        conditions: [{ type: "hasAttachment" }],
        actions: [{ type: "archive" }, { type: "archive" }],
      }).success
    ).toBe(false);
  });
});
