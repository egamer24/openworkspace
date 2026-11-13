import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { DEMO_UNSUBSCRIBE_HOST } from "@open-workspace/email/worker/mail/demo-routes.ts";
import { inboundMessageId } from "@open-workspace/email/worker/mail/inbound.ts";
import type { WorkspaceFeedbackSummary } from "@open-workspace/email/worker/mail/workspace-safety.ts";
import type { NewEmail } from "@open-workspace/email/worker/mailbox/schema.ts";
import { z } from "zod";

import { jsonValue, readJson } from "./json.ts";
import type { JsonValue } from "./json.ts";
import { drainInbound } from "./mail-flow-helpers.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/** The workspace's spam feedback about a sender, as another mailbox's classifier reads it (in the Worker). */
const workspaceFeedbackSummary = (mailboxId: string, address: string) =>
  hooks.call<WorkspaceFeedbackSummary>(
    "mailFlow.workspaceFeedbackSummary",
    mailboxId,
    address
  );

/** A JSON object body, for bodies a test matches whole or reads one field of. */
const jsonObject = z.record(z.string(), jsonValue);

/** The parts of a conversation view these tests read; the rest passes through for `toMatchObject`. */
const conversationView = z.looseObject({
  mailboxState: z.string(),
  folderId: z.string().nullable(),
  messages: z.array(
    z.looseObject({
      id: z.string(),
      isRead: z.boolean(),
      reported: z.boolean(),
      unsubscription: z
        .looseObject({ status: z.string(), method: z.string() })
        .nullable(),
      sender: z
        .looseObject({
          block: z
            .looseObject({ pattern: z.string(), workspace: z.boolean() })
            .nullable(),
          trustedAt: z.number().nullable(),
        })
        .nullable(),
      screening: z.looseObject({ blocked: z.string().nullable() }).nullable(),
      security: z
        .looseObject({
          warnings: z.array(z.looseObject({ kind: z.string() })),
          replyToMismatch: jsonValue,
        })
        .nullable(),
    })
  ),
});

const mailboxesBody = z.looseObject({
  mailboxes: z.array(z.looseObject({ id: z.string() })),
});

const bootstrapBody = z.looseObject({
  user: z.looseObject({ id: z.string() }),
});

const blockedSendersBody = z.looseObject({
  blocked: z.array(z.looseObject({ pattern: z.string() })),
});

let cookie = "";
let mailboxId = "";
let userId = "";

function request(
  path: string,
  init: { method?: string; json?: JsonValue } = {}
) {
  const headers = new Headers({ cookie });

  if (init.json !== undefined) headers.set("content-type", "application/json");

  return worker.fetch(
    new Request(`http://example.test${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );
}

async function api(
  path: string,
  init: { method?: string; json?: JsonValue } = {}
) {
  const response = await request(path, init);

  return {
    status: response.status,
    body: await readJson(response, jsonObject),
  };
}

function incoming(id: string, overrides: Partial<NewEmail> = {}): NewEmail {
  return {
    id,
    conversationId: `conv_${id}`,
    direction: "incoming",
    fromJson: [{ address: "news@list.example", name: "List" }],
    toJson: [{ address: "admin@example.test", name: null }],
    subject: `Subject ${id}`,
    timelineAt: new Date(),
    transportState: "received",
    ...overrides,
  };
}

async function deliver(raw: string, envelopeFrom: string) {
  const box = mailbox(mailboxId);
  const id = `delivery_${crypto.randomUUID()}`;
  const rawObjectKey = `test/${id}/raw.eml`;
  await env.MAIL_STORAGE.put(rawObjectKey, raw);
  await box.enqueueInbound({
    id,
    mailboxId,
    rawObjectKey,
    envelopeFrom,
    envelopeTo: "admin@example.test",
    receivedAt: Date.now(),
  });
  await drainInbound(mailboxId);
  const email = await box.getEmail(inboundMessageId(id));
  expect(email).toBeTruthy();

  return required(email, "the delivered message is stored");
}

async function conversationState(conversationId: string) {
  const response = await request(
    `/api/mail/conversations/${conversationId}?mailboxId=${mailboxId}`
  );

  return readJson(response, conversationView);
}

/** The first message of a conversation view. */
function firstMessage(view: z.output<typeof conversationView>) {
  return required(view.messages[0], "the conversation has a message");
}

function rawMessage(from: string, subject: string, extra: string[] = []) {
  return [
    `From: ${from}`,
    "To: admin@example.test",
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@sender.example>`,
    ...extra,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello",
    "",
  ].join("\r\n");
}

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  expect(bootstrap.status).toBe(200);
  cookie = required(
    bootstrap.headers.get("set-cookie")?.split(";", 1)[0],
    "bootstrap sets a session cookie"
  );

  const { mailboxes } = await readJson(
    await request("/api/mail/mailboxes"),
    mailboxesBody
  );

  mailboxId = required(mailboxes[0], "the admin has a mailbox").id;

  const state = await readJson(await request("/api/bootstrap"), bootstrapBody);
  userId = state.user.id;
});

describe("sender blocks at ingestion", () => {
  it("sends blocked senders to Spam before AI", async () => {
    expect(
      (
        await api(`/api/mail/mailboxes/${mailboxId}/blocked-senders`, {
          method: "POST",
          json: { pattern: "spam.example" },
        })
      ).body
    ).toMatchObject({
      ok: true,
      block: { pattern: "@spam.example", scope: "domain" },
    });
    expect(
      (
        await api(`/api/mail/mailboxes/${mailboxId}/blocked-senders`, {
          method: "POST",
          json: { pattern: "admin@example.test" },
        })
      ).status
    ).toBe(400);

    const blocked = await deliver(
      rawMessage("Deals <deals@mail.spam.example>", "Deal"),
      "bounce@spam.example"
    );

    const blockedView = await conversationState(blocked.conversationId);
    expect(blockedView.mailboxState).toBe("spam");
    expect(blockedView.messages[0]).toMatchObject({
      screening: { blocked: "mailbox" },
      sender: { block: { pattern: "@spam.example", workspace: false } },
    });

    const other = await deliver(
      rawMessage("Digest <hello@digest.example>", "Your weekly digest"),
      "b@digest.example"
    );

    const otherView = await conversationState(other.conversationId);
    expect(otherView.mailboxState).toBe("active");
    expect(firstMessage(otherView).screening).toBeNull();
  });

  it("applies workspace-wide blocks from administrators in every mailbox", async () => {
    await mailbox(mailboxId).insertEmail(
      incoming("msg_evil_old", {
        fromJson: [{ address: "cfo@mail.evil.example", name: "CFO" }],
      })
    );
    expect(
      (
        await api("/api/admin/blocked-senders", {
          method: "POST",
          json: { pattern: "@evil.example" },
        })
      ).body
    ).toMatchObject({
      ok: true,
      pattern: "@evil.example",
      moved: { conversations: 1, mailboxes: 1, failedMailboxes: 0 },
    });
    expect((await conversationState("conv_msg_evil_old")).mailboxState).toBe(
      "spam"
    );
    expect(
      (
        await api("/api/admin/blocked-senders", {
          method: "POST",
          json: { pattern: "example.test" },
        })
      ).status
    ).toBe(400);

    const email = await deliver(
      rawMessage("CEO <ceo@evil.example>", "Urgent"),
      "ceo@evil.example"
    );

    const view = await conversationState(email.conversationId);
    expect(view.mailboxState).toBe("spam");
    expect(firstMessage(view).screening).toMatchObject({
      blocked: "workspace",
    });

    const listed = await api("/api/admin/blocked-senders");
    expect(listed.body.blockedSenders).toEqual([
      {
        pattern: "@evil.example",
        scope: "domain",
        createdByName: expect.any(String),
        createdAt: expect.any(String),
      },
    ]);
    expect(
      (
        await api("/api/admin/blocked-senders?pattern=%40evil.example", {
          method: "DELETE",
        })
      ).body.ok
    ).toBe(true);
    expect(
      (await api("/api/admin/blocked-senders")).body.blockedSenders
    ).toEqual([]);
    expect(
      (
        await api("/api/admin/blocked-senders?pattern=%40evil.example", {
          method: "DELETE",
        })
      ).status
    ).toBe(404);
  });

  it("moves existing mail when asked, unblocks, and trusts senders", async () => {
    const box = mailbox(mailboxId);
    await box.insertEmail(
      incoming("msg_existing_1", {
        fromJson: [{ address: "pest@pests.example", name: null }],
      })
    );
    await api(`/api/mail/mailboxes/${mailboxId}/blocked-senders`, {
      method: "POST",
      json: { pattern: "pest@pests.example", moveExisting: true },
    });
    expect((await conversationState("conv_msg_existing_1")).mailboxState).toBe(
      "spam"
    );

    const list = await readJson(
      await request(`/api/mail/mailboxes/${mailboxId}/blocked-senders`),
      blockedSendersBody
    );

    expect(list.blocked.map((item) => item.pattern)).toContain(
      "pest@pests.example"
    );
    expect(
      (
        await api(
          `/api/mail/mailboxes/${mailboxId}/blocked-senders?pattern=pest%40pests.example`,
          { method: "DELETE" }
        )
      ).body.ok
    ).toBe(true);

    expect(
      (
        await api(
          `/api/mail/messages/msg_existing_1/not-spam?mailboxId=${mailboxId}`,
          { method: "POST" }
        )
      ).body
    ).toMatchObject({ ok: true, restored: true });
    const view = await conversationState("conv_msg_existing_1");
    expect(view.mailboxState).toBe("active");
    expect(firstMessage(view).sender?.trustedAt).toEqual(expect.any(Number));
  });
});

describe("unsubscribe", () => {
  it("performs one-click against the demo endpoint and records it per list", async () => {
    const box = mailbox(mailboxId);
    await box.insertEmail(
      incoming("msg_news_1", {
        listId: "weekly.list.example",
        listUnsubscribeJson: {
          httpsUrl: `https://${DEMO_UNSUBSCRIBE_HOST}/one-click/abc`,
          mailto: null,
          oneClick: true,
          reason: null,
        },
      })
    );
    await box.insertEmail(
      incoming("msg_news_2", {
        conversationId: "conv_msg_news_1",
        listId: "<Weekly.List.example>",
      })
    );

    const result = await api(
      `/api/mail/messages/msg_news_1/unsubscribe?mailboxId=${mailboxId}`,
      { method: "POST", json: {} }
    );

    expect(result.body).toMatchObject({
      ok: true,
      outcome: "done",
      unsubscription: {
        method: "one_click",
        status: "done",
        target: DEMO_UNSUBSCRIBE_HOST,
      },
    });
    const view = await conversationState("conv_msg_news_1");
    expect(
      view.messages.map((message) => message.unsubscription?.status)
    ).toEqual(["done", "done"]);
  });

  it("falls back to an unsubscribe email, or to the page for the person to open", async () => {
    const box = mailbox(mailboxId);
    await box.insertEmail(
      incoming("msg_mailto", {
        fromJson: [{ address: "promo@shop.example", name: "Shop" }],
        listUnsubscribeJson: {
          httpsUrl: "https://shop.example/u/1",
          mailto: "mailto:leave@shop.example?subject=stop",
          oneClick: false,
          reason: "no-post",
        },
      })
    );

    const mailto = await api(
      `/api/mail/messages/msg_mailto/unsubscribe?mailboxId=${mailboxId}`,
      { method: "POST", json: {} }
    );

    expect(mailto.body).toMatchObject({
      ok: true,
      outcome: "requested",
      unsubscription: { method: "mailto", target: "leave@shop.example" },
    });

    await box.insertEmail(
      incoming("msg_link", {
        fromJson: [{ address: "promo@store.example", name: "Store" }],
        listUnsubscribeJson: {
          httpsUrl: "https://store.example/u/2",
          mailto: null,
          oneClick: false,
          reason: "no-post",
        },
      })
    );

    const link = await api(
      `/api/mail/messages/msg_link/unsubscribe?mailboxId=${mailboxId}`,
      { method: "POST", json: {} }
    );

    expect(link.body).toMatchObject({
      ok: true,
      outcome: "link",
      url: "https://store.example/u/2",
      unsubscription: null,
    });

    const opened = await api(
      `/api/mail/messages/msg_link/unsubscribe?mailboxId=${mailboxId}`,
      { method: "POST", json: { method: "link" } }
    );

    expect(opened.body).toMatchObject({
      outcome: "opened",
      unsubscription: { status: "opened" },
    });
  });
});

describe("reporting", () => {
  it("records spam feedback for the classifier and hides reported senders from suggestions", async () => {
    const box = mailbox(mailboxId);
    await box.insertEmail(
      incoming("msg_spam", {
        fromJson: [{ address: "spammer@junk.example", name: "Junk" }],
      })
    );

    const report = await api(
      `/api/mail/messages/msg_spam/report?mailboxId=${mailboxId}`,
      { method: "POST" }
    );

    expect(report.body).toEqual({ ok: true, moved: true });
    const reported = await conversationState("conv_msg_spam");
    expect(reported.mailboxState).toBe("spam");
    expect(reported.messages[0]).toMatchObject({ reported: true });

    const suggestions = await api(
      `/api/mail/mailboxes/${mailboxId}/recipient-suggestions?q=junk&limit=5`
    );

    expect(suggestions.body.suggestions).toEqual([]);

    // Other mailboxes' classifiers hear about it; "not spam" takes it back.
    expect(
      await workspaceFeedbackSummary("mbx_elsewhere", "Spammer@junk.example")
    ).toEqual({
      spamReports: 1,
      notSpam: 0,
      domainReports: 0,
      reportingMailboxes: 1,
    });
    expect(
      await workspaceFeedbackSummary(mailboxId, "spammer@junk.example")
    ).toMatchObject({ spamReports: 0 });
    expect(
      (
        await api(
          `/api/mail/messages/msg_spam/not-spam?mailboxId=${mailboxId}`,
          { method: "POST" }
        )
      ).body
    ).toEqual({ ok: true, restored: true });
    expect(
      await workspaceFeedbackSummary("mbx_elsewhere", "spammer@junk.example")
    ).toMatchObject({ spamReports: 0, notSpam: 1, reportingMailboxes: 0 });
    expect(
      (await conversationState("conv_msg_spam")).messages[0]
    ).toMatchObject({ reported: false });
    expect(userId).toBeTruthy();
  });

  it("reports selected conversations as spam", async () => {
    await mailbox(mailboxId).insertEmail(
      incoming("msg_bulk_spam", {
        fromJson: [{ address: "bulk@junk.example", name: null }],
      })
    );

    const report = await api(
      `/api/mail/conversations/report?mailboxId=${mailboxId}`,
      {
        method: "POST",
        json: { conversationIds: ["conv_msg_bulk_spam"] },
      }
    );

    expect(report.body).toEqual({ ok: true, reportedCount: 1 });
    expect((await conversationState("conv_msg_bulk_spam")).mailboxState).toBe(
      "spam"
    );
  });
});
