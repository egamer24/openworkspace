import { describe, expect, it } from "bun:test";

import { replyAlias } from "../../worker/mail/reply-plan";
import { forwardHops, pickAddress } from "../../worker/mail/routing";
import type { AddressRow } from "../../worker/mail/routing";

function raw(...headers: string[]) {
  return new TextEncoder().encode(
    [...headers, "Subject: hi", "", "body"].join("\r\n")
  ).buffer;
}

function row(localPart: string, extra: Partial<AddressRow> = {}): AddressRow {
  return {
    id: `mbx_${localPart}`,
    localPart,
    catchAll: false,
    delivery: "inbox",
    aliasOf: null,
    forwardTo: null,
    ...extra,
  };
}

describe("pickAddress", () => {
  const sam = row("sam");
  const tagged = row("sam+news");
  const catchAll = row("support", { catchAll: true });
  const rows = [catchAll, sam, tagged];

  it("takes the exact address first, even one with a tag", () => {
    expect(pickAddress(rows, "sam")).toBe(sam);
    expect(pickAddress(rows, "sam+news")).toBe(tagged);
  });

  it("takes the plus base when the tagged address doesn't exist", () => {
    expect(pickAddress(rows, "sam+shop")).toBe(sam);
    expect(pickAddress(rows, "sam+a+b")).toBe(sam);
  });

  it("falls back to the catch-all, then to nothing", () => {
    expect(pickAddress(rows, "nobody")).toBe(catchAll);
    expect(pickAddress(rows, "nobody+shop")).toBe(catchAll);
    expect(pickAddress([sam], "nobody")).toBeNull();
  });

  it("doesn't read a leading plus as a tag", () => {
    expect(pickAddress([row("")], "+shop")).toBeNull();
  });

  it("treats an alias or a forward like any address", () => {
    const alias = row("billing", { delivery: "alias", aliasOf: "mbx_sam" });

    expect(pickAddress([catchAll, alias], "billing+q3")).toBe(alias);
  });
});

describe("replyAlias", () => {
  const aliases = [{ address: "billing@example.test", displayName: "Billing" }];

  it("answers mail delivered to an alias from it", () => {
    expect(
      replyAlias(
        {
          direction: "incoming",
          envelopeTo: "Billing@Example.test",
          fromJson: [{ address: "client@outside.test", name: null }],
        },
        aliases
      )
    ).toEqual(aliases[0]);
  });

  it("keeps sending from the alias a sent message came from", () => {
    expect(
      replyAlias(
        {
          direction: "outgoing",
          envelopeTo: null,
          fromJson: [{ address: "billing@example.test", name: null }],
        },
        aliases
      )
    ).toEqual(aliases[0]);
  });

  it("uses the mailbox's own address otherwise", () => {
    expect(
      replyAlias(
        {
          direction: "incoming",
          envelopeTo: "sam+shop@example.test",
          fromJson: [],
        },
        aliases
      )
    ).toBeNull();
  });
});

describe("forwardHops", () => {
  it("is zero without a hop header", () => {
    expect(forwardHops(raw())).toBe(0);
  });

  it("takes the largest digits-only value", () => {
    expect(
      forwardHops(
        raw("X-OpenWorkspace-Forwarded: 1", "x-openworkspace-forwarded: 2")
      )
    ).toBe(2);
  });

  it("ignores values a sender could use to lift the limit", () => {
    expect(forwardHops(raw("X-OpenWorkspace-Forwarded: -1000000"))).toBe(0);
    expect(forwardHops(raw("X-OpenWorkspace-Forwarded: 1e9"))).toBe(0);
    expect(
      forwardHops(
        raw("X-OpenWorkspace-Forwarded: -5", "X-OpenWorkspace-Forwarded: 3")
      )
    ).toBe(3);
  });

  it("does not read the body", () => {
    expect(
      forwardHops(
        new TextEncoder().encode(
          "Subject: hi\r\n\r\nX-OpenWorkspace-Forwarded: 9"
        ).buffer
      )
    ).toBe(0);
  });
});
