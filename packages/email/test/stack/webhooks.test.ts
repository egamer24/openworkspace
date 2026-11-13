import { beforeAll, describe, expect, it } from "bun:test";

import {
  createDb,
  mailboxAddressSql,
  mailboxes,
  webhookDeliveries,
} from "@open-workspace/core/module";
import type {
  WebhookDeliveryJob,
  WebhookDispatchJob,
} from "@open-workspace/core/module";
import { coreQueueRoles, required } from "@open-workspace/core/shared";
import { internet } from "@open-workspace/core/testing";
import { eq } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import { z } from "zod";

import {
  EMAIL_RECEIVED_EVENT,
  EMAIL_SENT_EVENT,
  EMAIL_WEBHOOK_SOURCE,
} from "../../shared/webhooks.ts";
import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import { bootstrapAdmin } from "./mail-flow-helpers.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/** A created webhook: its id, and the signing secret shown only now. */
const createdWebhook = z.looseObject({
  signingSecret: z.string(),
  webhook: z.looseObject({ id: z.string() }),
});

const idList = z.array(z.looseObject({ id: z.string() }));

// "keeps one event ID across queue ingress retries" needs no binding: test/unit/webhook-ingress.test.ts.

/**
 * Runs the Worker's webhooks consumer on a dispatch job, with a queue that
 * records the delivery jobs instead of delivering them (hooks/mail-flow.ts).
 */
async function dispatch(job: WebhookDispatchJob) {
  const result = await hooks.call<{
    ack: number;
    retry: number;
    sent: WebhookDeliveryJob[][];
  }>("mailFlow.webhooks.dispatch", job);

  expect(result).toMatchObject({ ack: 1, retry: 0 });
  expect(result.sent).toHaveLength(1);

  const [batch] = result.sent;

  return required(batch?.[0], "the dispatch queues a delivery job");
}

/** Runs the Worker's queue handler on one delivery job; its single outcome. */
async function deliver(job: WebhookDeliveryJob, attempts = 1) {
  const { outcomes, error } = await hooks.queue(coreQueueRoles.webhooks, [
    { body: job, attempts },
  ]);

  expect(error).toBeUndefined();

  const [outcome] = outcomes;

  return required(outcome, "the queue handler answers for the job");
}

/** Answers the Worker's requests to one webhook URL; what it received. */
function endpoint(url: string, respond: () => Response) {
  const received: { body: string; headers: Headers }[] = [];
  internet.handle(async (request) => {
    if (request.url !== url) return undefined;
    received.push({ body: await request.text(), headers: request.headers });

    return respond();
  });

  return received;
}

describe("account webhooks", () => {
  let adminCookie: string;
  let adminMailboxId: string;

  beforeAll(async () => {
    adminCookie = await bootstrapAdmin(
      "webhooks@example.test",
      "Webhook Admin"
    );

    const ownMailbox = await env.DB.prepare(
      "SELECT id FROM mailboxes WHERE owner_user_id IS NOT NULL"
    ).first<{ id: string }>();

    adminMailboxId = required(ownMailbox, "the admin has a mailbox").id;
  });

  it("queues email.sent only after submission and isolates queue failures", async () => {
    // deferEmailSentWebhook with a webhooks queue that always fails.
    const result = await hooks.call<{
      deferred: number;
      settled: { ok: boolean; value?: unknown };
      sends: number;
    }>("mailFlow.webhooks.emailSentWithFailingQueue");

    expect(result.deferred).toBe(1);
    expect(result.settled).toEqual({ ok: true, value: undefined });
    expect(result.sends).toBe(3);
  });

  it("requires HTTPS and only reveals the signing secret on creation", async () => {
    const invalid = await worker.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Insecure",
          url: "http://hooks.example.test/openworkspace",
          events: [EMAIL_RECEIVED_EVENT],
          mailboxIds: [adminMailboxId],
          enabled: true,
        }),
      })
    );

    expect(invalid.status).toBe(400);

    const created = await worker.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Automation",
          url: "https://hooks.example.test/openworkspace",
          events: ["user.joined"],
          enabled: true,
        }),
      })
    );

    expect(created.status).toBe(201);

    const createdBody = await readJson(created, createdWebhook);

    expect(createdBody.signingSecret).toMatch(/^whsec_/u);

    const listed = await worker.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        headers: { cookie: adminCookie },
      })
    );

    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).toContain(createdBody.webhook.id);
    expect(listedText).not.toContain(createdBody.signingSecret);
    expect(listedText).not.toContain("signingSecret");
  });

  it("fans out subscribed events and signs a payload with text and HTML bodies", async () => {
    const created = await worker.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Mail processor",
          url: "https://hooks.example.test/mail",
          events: [EMAIL_RECEIVED_EVENT],
          mailboxIds: [adminMailboxId],
          enabled: true,
        }),
      })
    );

    const createdBody = await readJson(created, createdWebhook);

    const [box] = await createDb(env.DB)
      .select({ id: mailboxes.id, address: mailboxAddressSql })
      .from(mailboxes)
      .limit(1);

    const { id: boxId, address: boxAddress } = required(
      box,
      "the workspace has a mailbox"
    );

    const messageId = "msg_webhook_body";
    const htmlKey = `mailboxes/${boxId}/messages/${messageId}/body.html`;
    await env.MAIL_STORAGE.put(htmlKey, "<p>Hello from HTML</p>");
    await mailbox(boxId).seedMailbox(
      [],
      [
        {
          id: messageId,
          conversationId: "conv_webhook_body",
          direction: "incoming",
          fromJson: [{ address: "sender@example.net", name: "Sender" }],
          toJson: [{ address: boxAddress, name: null }],
          subject: "Webhook body",
          bodyText: "Hello from text",
          bodyHtmlR2Key: htmlKey,
          timelineAt: new Date("2026-08-24T10:00:00.000Z"),
          transportState: "received",
        },
      ]
    );

    const deliveryJob = await dispatch({
      type: "dispatch",
      eventId: "evt_webhook_body",
      eventType: EMAIL_RECEIVED_EVENT,
      occurredAt: Date.now(),
      source: { kind: EMAIL_WEBHOOK_SOURCE, mailboxId: boxId, messageId },
    });

    const received = endpoint(
      "https://hooks.example.test/mail",
      () => new Response("accepted", { status: 202 })
    );

    const [delivery, duplicate] = await Promise.all([
      deliver(deliveryJob),
      deliver(deliveryJob),
    ]);

    expect(delivery).toMatchObject({ ack: true, retry: false });
    expect(duplicate).toMatchObject({ ack: true, retry: false });
    expect(received).toHaveLength(1);

    const [request] = received;

    const { body, headers } = required(
      request,
      "the endpoint got the delivery"
    );

    expect(JSON.parse(body)).toMatchObject({
      id: "evt_webhook_body",
      type: EMAIL_RECEIVED_EVENT,
      data: {
        email: {
          subject: "Webhook body",
          body: {
            text: "Hello from text",
            html: "<p>Hello from HTML</p>",
          },
        },
      },
    });
    // Verified the way a Standard Webhooks library does it.
    const id = headers.get("webhook-id");
    const timestamp = headers.get("webhook-timestamp");
    const signature = headers.get("webhook-signature");
    expect(id).toMatch(/^whd_/u);
    expect(timestamp).toMatch(/^\d+$/u);
    expect(createdBody.signingSecret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/u);

    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(
        atob(createdBody.signingSecret.slice("whsec_".length)),
        (character) => character.charCodeAt(0)
      ),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const expected = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${body}`)
    );

    expect(signature).toBe(
      `v1,${btoa(String.fromCharCode(...new Uint8Array(expected)))}`
    );
    // And by the reference library.
    expect(
      new Webhook(createdBody.signingSecret).verify(
        body,
        Object.fromEntries(headers)
      )
    ).toMatchObject({
      id: "evt_webhook_body",
    });

    const [stored] = await createDb(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, createdBody.webhook.id))
      .limit(1);

    expect(stored).toMatchObject({
      status: "delivered",
      responseStatus: 202,
      attempts: 1,
    });
  });

  it("records the HTTP status and response body after a failed delivery", async () => {
    const created = await worker.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Failing endpoint",
          url: "https://hooks.example.test/failing",
          events: [EMAIL_RECEIVED_EVENT],
          mailboxIds: [adminMailboxId],
          enabled: true,
        }),
      })
    );

    const createdBody = await readJson(created, createdWebhook);

    const deliveryJob = await dispatch({
      type: "dispatch",
      eventId: "evt_webhook_failure",
      eventType: "webhook.test",
      occurredAt: Date.now(),
      endpointId: createdBody.webhook.id,
      source: { kind: "data", data: { message: "Failure test" } },
    });

    let answer = () => new Response("rate limited", { status: 429 });

    const received = endpoint("https://hooks.example.test/failing", () =>
      answer()
    );

    expect(await deliver(deliveryJob, 5)).toMatchObject({
      ack: true,
      retry: false,
    });
    expect(received).toHaveLength(1);

    const [delivery] = await createDb(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, createdBody.webhook.id))
      .limit(1);

    expect(delivery).toMatchObject({
      status: "failed",
      attempts: 5,
      responseStatus: 429,
      responseBody: "rate limited",
      error: "Endpoint returned HTTP 429",
    });

    answer = () => new Response("unexpected");
    expect(await deliver(deliveryJob)).toMatchObject({
      ack: true,
      retry: false,
    });
    expect(received).toHaveLength(1);

    const [unchangedDelivery] = await createDb(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(
        eq(
          webhookDeliveries.id,
          required(delivery, "the failed delivery is recorded").id
        )
      )
      .limit(1);

    expect(unchangedDelivery).toMatchObject({
      status: "failed",
      attempts: 5,
      responseStatus: 429,
    });
  });

  // The pool's fake fetch asserted `redirect: "error"`, a mode workerd rejects;
  // what it meant is checked against the endpoint instead.
  it("does not follow an endpoint's redirect", async () => {
    const created = await worker.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Redirecting endpoint",
          url: "https://hooks.example.test/redirecting",
          events: [EMAIL_RECEIVED_EVENT],
          mailboxIds: [adminMailboxId],
          enabled: true,
        }),
      })
    );

    const createdBody = await readJson(created, createdWebhook);

    const deliveryJob = await dispatch({
      type: "dispatch",
      eventId: "evt_webhook_redirect",
      eventType: "webhook.test",
      occurredAt: Date.now(),
      endpointId: createdBody.webhook.id,
      source: { kind: "data", data: { message: "Redirect test" } },
    });

    const redirected = endpoint(
      "https://hooks.example.test/redirecting",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example.test/hook" },
        })
    );

    const elsewhere = endpoint(
      "https://elsewhere.example.test/hook",
      () => new Response("followed")
    );

    expect(await deliver(deliveryJob, 5)).toMatchObject({
      ack: true,
      retry: false,
    });
    expect(redirected).toHaveLength(1);
    expect(elsewhere).toHaveLength(0);

    const [delivery] = await createDb(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, createdBody.webhook.id))
      .limit(1);

    expect(delivery).toMatchObject({
      status: "failed",
      responseStatus: 302,
      error: "Endpoint returned HTTP 302",
    });
  });

  it("does not deliver an event after the endpoint unsubscribes from it", async () => {
    const created = await worker.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Changing subscription",
          url: "https://hooks.example.test/changing",
          events: [EMAIL_RECEIVED_EVENT],
          mailboxIds: [adminMailboxId],
          enabled: true,
        }),
      })
    );

    const createdBody = await readJson(created, createdWebhook);

    const deliveryJob = await dispatch({
      type: "dispatch",
      eventId: "evt_webhook_unsubscribed",
      eventType: EMAIL_RECEIVED_EVENT,
      occurredAt: Date.now(),
      endpointId: createdBody.webhook.id,
      // A mailbox event names its mailbox, or no endpoint receives it.
      source: {
        kind: EMAIL_WEBHOOK_SOURCE,
        mailboxId: adminMailboxId,
        messageId: "msg_unsubscribed",
      },
    });

    const updated = await worker.fetch(
      new Request(
        `http://example.test/api/admin/webhooks/${createdBody.webhook.id}`,
        {
          method: "PUT",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({
            name: "Changing subscription",
            url: "https://hooks.example.test/changing",
            events: [EMAIL_SENT_EVENT],
            mailboxIds: [adminMailboxId],
            enabled: true,
          }),
        }
      )
    );

    expect(updated.status).toBe(200);

    const received = endpoint(
      "https://hooks.example.test/changing",
      () => new Response("unexpected")
    );

    expect(await deliver(deliveryJob)).toMatchObject({ ack: true });
    expect(received).toHaveLength(0);

    const [delivery] = await createDb(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, createdBody.webhook.id))
      .limit(1);

    expect(delivery).toMatchObject({
      status: "failed",
      error: "Webhook endpoint no longer subscribes to this event",
    });
  });
});

describe("mail webhooks and mailbox access", () => {
  const origin = "http://example.test";
  let adminCookie: string;
  let adminMailboxId: string;
  let memberId: string;
  let memberCookie: string;
  let teamId: string;
  let teamMailboxId: string;

  const call = (
    cookie: string,
    path: string,
    init: { method?: string; json?: unknown } = {}
  ) => {
    const headers = new Headers({ cookie, origin });

    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
    }

    return worker.fetch(
      new Request(`${origin}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
      })
    );
  };

  /** A dispatch run's delivery jobs for this email event. */
  async function mailDispatch(
    endpointId: string,
    mailboxId: string,
    eventId: string
  ) {
    const result = await hooks.call<{
      ack: number;
      sent: WebhookDeliveryJob[][];
    }>("mailFlow.webhooks.dispatch", {
      type: "dispatch",
      eventId,
      eventType: EMAIL_RECEIVED_EVENT,
      occurredAt: Date.now(),
      endpointId: undefined,
      source: {
        kind: EMAIL_WEBHOOK_SOURCE,
        mailboxId,
        messageId: "msg_scoped",
      },
    } satisfies WebhookDispatchJob);

    expect(result.ack).toBe(1);

    const deliveries = await env.DB.prepare(
      "SELECT id FROM webhook_deliveries WHERE webhook_id = ? AND event_id = ?"
    )
      .bind(endpointId, eventId)
      .all<{ id: string }>();

    return { jobs: result.sent.flat(), deliveries: deliveries.results };
  }

  beforeAll(async () => {
    const admin = await env.DB.prepare(
      "SELECT id FROM users WHERE role = 'admin'"
    ).first<{ id: string }>();

    const login = await worker.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: required(admin, "the workspace has an admin").id,
        }),
      })
    );

    adminCookie = sessionCookie(login);

    const ownMailbox = await env.DB.prepare(
      "SELECT id FROM mailboxes WHERE owner_user_id IS NOT NULL"
    ).first<{ id: string }>();

    adminMailboxId = required(ownMailbox, "the admin has a mailbox").id;

    const invited = await call(adminCookie, "/api/admin/invitations", {
      method: "POST",
      json: { name: "Integrations", email: "integrations@example.test" },
    });

    memberId = (
      await readJson(
        invited,
        z.object({ accessLink: z.looseObject({ userId: z.string() }) })
      )
    ).accessLink.userId;
    await env.DB.prepare(
      "UPDATE users SET status = 'active', permissions = '[\"manage_webhooks\"]' WHERE id = ?"
    )
      .bind(memberId)
      .run();

    const memberLogin = await worker.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: memberId }),
      })
    );

    memberCookie = sessionCookie(memberLogin);

    const team = await call(adminCookie, "/api/admin/teams", {
      method: "POST",
      json: {
        name: "Support",
        slug: "support",
        description: null,
        members: [{ userId: memberId, canSend: true }],
      },
    });

    teamId = (await readJson(team, z.looseObject({ teamId: z.string() })))
      .teamId;

    const shared = await call(adminCookie, "/api/admin/mailboxes", {
      method: "POST",
      json: {
        address: "support@example.test",
        displayName: "Support",
        ownerUserId: null,
        teamId,
      },
    });

    teamMailboxId = (
      await readJson(shared, z.looseObject({ mailboxId: z.string() }))
    ).mailboxId;
  });

  it("must name mailboxes the person saving it can open", async () => {
    const body = (mailboxIds: string[]) => ({
      name: "Support desk",
      url: "https://desk.example.test/hooks",
      events: [EMAIL_RECEIVED_EVENT, "user.joined"],
      mailboxIds,
      enabled: true,
    });

    const none = await call(memberCookie, "/api/admin/webhooks", {
      method: "POST",
      json: body([]),
    });

    expect(none.status).toBe(400);
    await none.body?.cancel();

    const others = await call(memberCookie, "/api/admin/webhooks", {
      method: "POST",
      json: body([adminMailboxId]),
    });

    expect(others.status).toBe(403);
    await others.body?.cancel();

    const unknown = await call(adminCookie, "/api/admin/webhooks", {
      method: "POST",
      json: body(["mbx_missing"]),
    });

    expect(unknown.status).toBe(403);
    await unknown.body?.cancel();

    // Mailboxes belong to mail events only.
    const stray = await call(memberCookie, "/api/admin/webhooks", {
      method: "POST",
      json: { ...body([teamMailboxId]), events: ["user.joined"] },
    });

    expect(stray.status).toBe(400);
    await stray.body?.cancel();

    const listing = await call(memberCookie, "/api/admin/webhooks");

    const { mailboxes: choices } = await readJson(
      listing,
      z.looseObject({ mailboxes: idList })
    );

    const choiceIds = choices.map((choice) => choice.id);
    expect(choiceIds).toContain(teamMailboxId);
    expect(choiceIds).not.toContain(adminMailboxId);
  });

  it("delivers a mailbox's mail only while whoever saved it can open that mailbox", async () => {
    const created = await call(memberCookie, "/api/admin/webhooks", {
      method: "POST",
      json: {
        name: "Support desk",
        url: "https://desk.example.test/hooks",
        events: [EMAIL_RECEIVED_EVENT, "user.joined"],
        mailboxIds: [teamMailboxId],
        enabled: true,
      },
    });

    expect(created.status).toBe(201);

    const endpointId = (await readJson(created, createdWebhook)).webhook.id;

    expect(
      (await mailDispatch(endpointId, teamMailboxId, "evt_scoped_team"))
        .deliveries
    ).toHaveLength(1);
    // Mail from a mailbox it does not name never reaches it.
    expect(
      (await mailDispatch(endpointId, adminMailboxId, "evt_scoped_admin"))
        .deliveries
    ).toHaveLength(0);

    // Other events are as before.
    const joined = await hooks.call<{ sent: WebhookDeliveryJob[][] }>(
      "mailFlow.webhooks.dispatch",
      {
        type: "dispatch",
        eventId: "evt_scoped_join",
        eventType: "user.joined",
        occurredAt: Date.now(),
        source: { kind: "data", data: { user: { id: memberId } } },
      } satisfies WebhookDispatchJob
    );

    expect(joined.sent.flat().length).toBeGreaterThan(0);

    // Queued while they could open it; they leave the team before it goes out.
    const { jobs } = await mailDispatch(
      endpointId,
      teamMailboxId,
      "evt_scoped_late"
    );

    const left = await call(adminCookie, `/api/admin/teams/${teamId}`, {
      method: "PATCH",
      json: {
        name: "Support",
        slug: "support",
        description: null,
        members: [],
      },
    });

    expect(left.status).toBe(200);
    await left.body?.cancel();

    const received = endpoint(
      "https://desk.example.test/hooks",
      () => new Response("ok")
    );

    const late = jobs.filter((job) => job.type === "deliver");
    expect(late).toHaveLength(1);

    const [lateJob] = late;
    expect(
      await deliver(required(lateJob, "the late delivery job"))
    ).toMatchObject({ ack: true });

    expect(received).toHaveLength(0);

    const skipped = await env.DB.prepare(
      "SELECT status, error FROM webhook_deliveries WHERE webhook_id = ? AND event_id = ?"
    )
      .bind(endpointId, "evt_scoped_late")
      .first<{ status: string; error: string }>();

    expect(skipped).toMatchObject({
      status: "failed",
      error: expect.stringContaining("can no longer open the mailbox"),
    });
    expect(
      (await mailDispatch(endpointId, teamMailboxId, "evt_scoped_after"))
        .deliveries
    ).toHaveLength(0);

    // Administration says so.
    const listing = await call(adminCookie, "/api/admin/webhooks");

    const { webhooks } = await readJson(
      listing,
      z.looseObject({
        webhooks: z.array(
          z.looseObject({
            id: z.string(),
            savedBy: z.string(),
            mailboxes: z.array(
              z.looseObject({ id: z.string(), available: z.boolean() })
            ),
          })
        ),
      })
    );

    expect(webhooks.find((webhook) => webhook.id === endpointId)).toMatchObject(
      {
        savedBy: "Integrations",
        mailboxes: [{ id: teamMailboxId, available: false }],
      }
    );

    // An administrator who saves it again answers for it, and mail flows.
    const saved = await call(adminCookie, `/api/admin/webhooks/${endpointId}`, {
      method: "PUT",
      json: {
        name: "Support desk",
        url: "https://desk.example.test/hooks",
        events: [EMAIL_RECEIVED_EVENT, "user.joined"],
        mailboxIds: [teamMailboxId],
        enabled: true,
      },
    });

    expect(saved.status).toBe(200);
    await saved.body?.cancel();
    expect(
      (await mailDispatch(endpointId, teamMailboxId, "evt_scoped_resaved"))
        .deliveries
    ).toHaveLength(1);
  });
});
