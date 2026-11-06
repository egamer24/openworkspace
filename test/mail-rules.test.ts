import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateRules,
  forwardHops,
  headerBlock,
  ruleInputSchema,
  ruleMatches,
  type RuleInput,
  type RuleSubject,
} from "../worker/mail/rules";
import { inboundMessageId } from "../worker/mail/inbound";
import { mailboxStub } from "../worker/mailbox";

const subject = (overrides: Partial<RuleSubject> = {}): RuleSubject => ({
  fromJson: [{ address: "news@mail.shop.example", name: "Shop" }],
  toJson: [{ address: "me@example.test", name: null }],
  ccJson: [],
  subject: "Weekly deals",
  listId: "<deals.shop.example>",
  attachmentsJson: [],
  ...overrides,
});

const rule = (input: Partial<RuleInput> & Pick<RuleInput, "conditions" | "actions">, id = "r1") => ({
  id,
  name: id,
  enabled: true,
  match: "all" as const,
  stopProcessing: false,
  ...input,
});

describe("rule matching", () => {
  it.each([
    [{ type: "from", op: "domain", value: "shop.example" }, true],
    [{ type: "from", op: "domain", value: "@shop.example" }, true],
    [{ type: "from", op: "domain", value: "op.example" }, false],
    [{ type: "from", op: "equals", value: "NEWS@mail.shop.example" }, true],
    [{ type: "from", op: "contains", value: "news@" }, true],
    [{ type: "recipient", op: "equals", value: "me@example.test" }, true],
    [{ type: "subject", op: "contains", value: "DEALS" }, true],
    [{ type: "subject", op: "equals", value: "Weekly" }, false],
    [{ type: "listId", op: "exists" }, true],
    [{ type: "listId", op: "contains", value: "deals.shop" }, true],
    [{ type: "hasAttachment" }, false],
  ] as const)("%j matches: %s", (condition, expected) => {
    expect(ruleMatches({ match: "all", conditions: [condition] }, subject())).toBe(expected);
  });

  it("combines conditions with all or any", () => {
    const conditions = [
      { type: "subject", op: "contains", value: "deals" },
      { type: "hasAttachment" },
    ] as const;
    expect(ruleMatches({ match: "all", conditions: [...conditions] }, subject())).toBe(false);
    expect(ruleMatches({ match: "any", conditions: [...conditions] }, subject())).toBe(true);
  });

  it("applies rules in order, honors stop, and lets notSpam rescue AI spam", () => {
    const outcome = evaluateRules([
      rule({ conditions: [{ type: "listId", op: "exists" }], actions: [{ type: "archive" }, { type: "markRead" }] }, "a"),
      rule({
        conditions: [{ type: "from", op: "domain", value: "shop.example" }],
        actions: [{ type: "notSpam" }, { type: "forward", to: "me@other.example", keepCopy: true }],
        stopProcessing: true,
      }, "b"),
      rule({ conditions: [{ type: "subject", op: "contains", value: "deals" }], actions: [{ type: "trash" }] }, "c"),
    ], subject(), "spam");
    expect(outcome).toEqual({
      mailboxState: "archive",
      folderId: null,
      markRead: true,
      forwards: [{ to: "me@other.example", keepCopy: true }],
      matchedRuleIds: ["a", "b"],
    });
    expect(evaluateRules([
      rule({ conditions: [{ type: "hasAttachment" }], actions: [{ type: "notSpam" }] }),
    ], subject({ attachmentsJson: [] }), "spam").matchedRuleIds).toEqual([]);
    expect(evaluateRules([
      rule({ conditions: [{ type: "listId", op: "exists" }], actions: [{ type: "notSpam" }] }),
    ], subject(), "spam").mailboxState).toBe("active");
    expect(evaluateRules([
      rule({ conditions: [{ type: "listId", op: "exists" }], actions: [{ type: "archive" }], enabled: false }),
    ], subject(), "active").matchedRuleIds).toEqual([]);
  });

  it("validates rule input", () => {
    const valid = { name: "x", conditions: [{ type: "hasAttachment" }], actions: [{ type: "archive" }] };
    expect(ruleInputSchema.safeParse(valid).success).toBe(true);
    expect(ruleInputSchema.safeParse({ ...valid, conditions: [] }).success).toBe(false);
    expect(ruleInputSchema.safeParse({ ...valid, actions: [{ type: "forward", to: "not-an-email" }] }).success).toBe(false);
    expect(ruleInputSchema.safeParse({ ...valid, actions: [{ type: "archive" }, { type: "archive" }] }).success).toBe(false);
    expect(ruleInputSchema.safeParse({
      ...valid,
      actions: ["a", "b", "c", "d"].map((local) => ({ type: "forward", to: `${local}@example.net` })),
    }).success).toBe(false);
  });

  it("reads the forward hop count from headers only", () => {
    const raw = (lines: string[]) => new TextEncoder().encode([...lines, "", "X-OpenWorkspace-Forwarded: 9"].join("\r\n")).buffer;
    expect(forwardHops(headerBlock(raw(["Subject: a", "X-OpenWorkspace-Forwarded: 2"])))).toBe(2);
    expect(forwardHops(headerBlock(raw(["Subject: a"])))).toBe(0);
  });
});

describe("rules on delivery", () => {
  it("forwards from the mailbox, trashes forward-only copies, and never loops", async () => {
    const mailboxId = `mbx_rules_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(env, mailboxId);
    expect(await mailbox.createRule({
      name: "Invoices to accounting",
      enabled: true,
      match: "all",
      conditions: [{ type: "subject", op: "contains", value: "invoice" }],
      actions: [{ type: "forward", to: "accounting@example.net", keepCopy: false }],
      stopProcessing: false,
    }, "usr_test")).toMatchObject({ status: "ok" });
    expect(await mailbox.createRule({
      name: "Lists to archive",
      enabled: true,
      match: "all",
      conditions: [{ type: "listId", op: "exists" }],
      actions: [{ type: "archive" }],
      stopProcessing: false,
    }, "usr_test")).toMatchObject({ status: "ok" });

    const deliver = async (label: string, envelopeFrom: string, headers: string[]) => {
      const id = `delivery_${label}_${crypto.randomUUID()}`;
      const rawObjectKey = `test/${id}.eml`;
      await env.MAIL_STORAGE.put(rawObjectKey, [
        `From: ${envelopeFrom}`,
        "To: me@example.test",
        `Message-ID: <${id}@example.net>`,
        ...headers,
        "Content-Type: text/plain",
        "",
        `Body of ${label}`,
      ].join("\r\n"));
      await mailbox.enqueueInbound({
        id,
        mailboxId,
        rawObjectKey,
        envelopeFrom,
        envelopeTo: "me@example.test",
        receivedAt: Date.now(),
      });
      return inboundMessageId(id);
    };

    // Already forwarded three times: dropped by the hop limit.
    await deliver("loop", "vendor@example.net", ["Subject: Invoice 7", "X-OpenWorkspace-Forwarded: 3"]);
    // The destination itself sending an invoice must not be forwarded back.
    await deliver("echo", "accounting@example.net", ["Subject: Invoice 8"]);
    const listId = await deliver("list", "news@example.net", ["Subject: News", "List-Id: <news.example.net>"]);
    const invoiceId = await deliver("invoice", "vendor@example.net", ["Subject: Invoice 1042"]);

    await runInDurableObject(mailbox, async (instance, state) => {
      const bindings = Reflect.get(instance, "bindings") as Env;
      const send = vi.spyOn(bindings.EMAIL, "send").mockResolvedValue({ messageId: "<fwd@example.test>" });
      try {
        // One delivery is processed per alarm wake.
        for (let wake = 0; wake < 4; wake += 1) {
          await state.storage.deleteAlarm();
          await instance.alarm();
        }

        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        expect(send.mock.calls[0]![0]).toMatchObject({
          from: { email: "me@example.test" },
          to: "accounting@example.net",
          replyTo: "vendor@example.net",
          subject: "Fwd: Invoice 1042",
          headers: { "Auto-Submitted": "auto-forwarded", "X-OpenWorkspace-Forwarded": "1" },
        });
        expect(String((send.mock.calls[0]![0] as { text: string }).text)).toContain("Body of invoice");

        const stateOf = (emailId: string) => state.storage.sql
          .exec<{ mailbox_state: string }>(
            "select c.mailbox_state from conversations c join emails e on e.conversation_id = c.id where e.id = ?",
            emailId,
          ).one().mailbox_state;
        await vi.waitFor(() => expect(stateOf(invoiceId)).toBe("trash"));
        expect(stateOf(listId)).toBe("archive");
      } finally {
        send.mockRestore();
      }
    });
  });
});

describe("rules API", () => {
  it("creates, tests, reorders and deletes rules with send access", async () => {
    const bootstrap = await exports.default.fetch(new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    }));
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    await bootstrap.json();
    const call = async (path: string, init: RequestInit = {}) => {
      const response = await exports.default.fetch(new Request(`http://example.test${path}`, {
        ...init,
        headers: { cookie, "content-type": "application/json" },
      }));
      return { status: response.status, body: await response.json<Record<string, any>>() };
    };
    const { body: { mailboxes: [mailbox] } } = await call("/api/mail/mailboxes");
    const base = `/api/mail/mailboxes/${mailbox.id}/rules`;
    const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

    expect((await post(base, {
      name: "Bad folder",
      conditions: [{ type: "hasAttachment" }],
      actions: [{ type: "moveToFolder", folderId: "fld_missing" }],
    })).status).toBe(400);

    const first = await post(base, {
      name: "Receipts",
      conditions: [{ type: "subject", op: "contains", value: "receipt" }],
      actions: [{ type: "archive" }],
    });
    expect(first.status).toBe(201);
    const second = await post(base, {
      name: "Lists",
      match: "any",
      conditions: [{ type: "listId", op: "exists" }],
      actions: [{ type: "markRead" }],
    });
    expect((await call(base)).body.rules.map((rule: { name: string }) => rule.name)).toEqual(["Receipts", "Lists"]);

    expect(await post(`${base}/test`, {
      match: "all",
      conditions: [{ type: "subject", op: "contains", value: "anything" }],
    })).toMatchObject({ status: 200, body: { matches: 0 } });

    expect((await call(`${base}/order`, {
      method: "PUT",
      body: JSON.stringify({ ruleIds: [second.body.rule.id, first.body.rule.id] }),
    })).status).toBe(200);
    expect((await call(base)).body.rules.map((rule: { name: string }) => rule.name)).toEqual(["Lists", "Receipts"]);
    expect((await call(`${base}/order`, {
      method: "PUT",
      body: JSON.stringify({ ruleIds: [first.body.rule.id] }),
    })).status).toBe(409);

    expect((await call(`${base}/${first.body.rule.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`${base}/${first.body.rule.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call("/api/mail/mailboxes/mbx_missing/rules")).status).toBe(403);
  });
});
