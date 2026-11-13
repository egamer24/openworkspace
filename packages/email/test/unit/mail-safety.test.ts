import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import {
  blockPatternsFor,
  normalizeBlockPattern,
} from "@open-workspace/email/shared/mail-feedback.ts";
import {
  messageSecurity,
  replyToMismatch,
} from "@open-workspace/email/worker/mail/message-security.ts";
import {
  parseMailtoUnsubscribe,
  postOneClick,
  unsubscribeListKey,
} from "@open-workspace/email/worker/mail/unsubscribe.ts";

describe("block patterns", () => {
  it("normalizes addresses and domains", () => {
    expect(normalizeBlockPattern(" Offers@Growth-Hack.invalid ")).toBe(
      "offers@growth-hack.invalid"
    );
    expect(normalizeBlockPattern("growth-hack.invalid")).toBe(
      "@growth-hack.invalid"
    );
    expect(normalizeBlockPattern("@Growth-Hack.invalid")).toBe(
      "@growth-hack.invalid"
    );
    expect(normalizeBlockPattern("not a domain")).toBeNull();
    expect(normalizeBlockPattern("a@b")).toBeNull();
  });

  it("lists the address and every parent domain that could block it", () => {
    expect(blockPatternsFor("Bob@Mail.Example.com")).toEqual([
      "bob@mail.example.com",
      "@mail.example.com",
      "@example.com",
    ]);
    expect(blockPatternsFor("nobody")).toEqual([]);
  });
});

describe("unsubscribe", () => {
  it("keys records by List-Id, else by the organizational domain", () => {
    expect(
      unsubscribeListKey({
        listId: "<Weekly.Margin-Notes.example>",
        fromAddress: "x@y.com",
      })
    ).toBe("list:weekly.margin-notes.example");
    expect(
      unsubscribeListKey({ listId: null, fromAddress: "news@mail.shop.co.uk" })
    ).toBe("domain:shop.co.uk");
  });

  it("parses mailto targets without extra recipients", () => {
    expect(
      parseMailtoUnsubscribe(
        "mailto:leave%2Bx1@list.example?subject=Remove%20me&cc=boss@example.com&body=a+b"
      )
    ).toEqual({
      to: "leave+x1@list.example",
      subject: "Remove me",
      body: "a+b",
    });
    expect(parseMailtoUnsubscribe("mailto:list@example.com")).toEqual({
      to: "list@example.com",
      subject: "unsubscribe",
      body: "unsubscribe",
    });
    expect(parseMailtoUnsubscribe("https://example.com")).toBeNull();
    expect(parseMailtoUnsubscribe("mailto:not-an-address")).toBeNull();
  });

  it("POSTs the RFC 8058 body once, without following redirects", async () => {
    const requests: Request[] = [];

    const result = await postOneClick("https://list.example/u/1", (request) => {
      requests.push(request);

      return Promise.resolve(new Response(null, { status: 202 }));
    });

    expect(result).toEqual({ ok: true, status: 202, redirected: false });
    expect(requests).toHaveLength(1);
    const request = required(requests[0], "the one-click request");
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(request.headers.get("cookie")).toBeNull();
    expect(await request.text()).toBe("List-Unsubscribe=One-Click");
  });

  it("treats 3xx as probably done and other statuses or timeouts as failures", async () => {
    expect(
      await postOneClick("https://list.example/u", () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://elsewhere.example" },
          })
        )
      )
    ).toEqual({ ok: true, status: 302, redirected: true });
    expect(
      await postOneClick("https://list.example/u", () =>
        Promise.resolve(new Response("no", { status: 500 }))
      )
    ).toMatchObject({ ok: false, status: 500 });
    expect(
      await postOneClick(
        "https://list.example/u",
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () =>
              reject(request.signal.reason)
            );
          }),
        10
      )
    ).toMatchObject({
      ok: false,
      status: null,
      detail: "The sender's server did not answer in time",
    });
    let called = false;
    expect(
      await postOneClick("http://list.example/u", () => {
        called = true;

        return Promise.resolve(new Response());
      })
    ).toMatchObject({ ok: false });
    expect(called).toBe(false);
  });
});

describe("reply-to mismatch", () => {
  it("flags replies that leave the sender's organization unless it is a list", () => {
    expect(
      replyToMismatch({
        fromAddress: "accounts@northwind-supplies.example",
        replyTo: ["x@quickmail.example"],
        listId: null,
      })
    ).toEqual({ address: "x@quickmail.example", domain: "quickmail.example" });
    expect(
      replyToMismatch({
        fromAddress: "reply@txn-email.playstation.com",
        replyTo: ["help@playstation.com"],
        listId: null,
      })
    ).toBeNull();
    expect(
      replyToMismatch({
        fromAddress: "a@list.example",
        replyTo: ["b@other.example"],
        listId: "dev.list.example",
      })
    ).toBeNull();
  });

  it("hides caution warnings and the first-time hint for trusted senders", () => {
    const input = {
      fromAddress: "accounts@northwind-supplies.example",
      authentication: null,
      listUnsubscribe: null,
      workspaceDomains: ["demo.example"],
      replyTo: ["x@quickmail.example"],
      history: { inboundCount: 1, outboundCount: 0 },
    };

    const untrusted = messageSecurity(input);
    expect(untrusted.warnings.map((warning) => warning.kind)).toEqual([
      "reply_to_mismatch",
    ]);
    expect(untrusted.firstTimeSender).toBe(true);
    const trusted = messageSecurity({ ...input, trusted: true });
    expect(trusted.warnings).toEqual([]);
    expect(trusted.firstTimeSender).toBe(false);
    expect(trusted.replyToMismatch).not.toBeNull();
  });
});
