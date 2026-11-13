import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { internet } from "@open-workspace/core/testing";
import type { MailboxPushJob } from "@open-workspace/email/shared/mail.ts";
import { z } from "zod";

import { emailQueueRoles } from "../../shared/module.ts";
import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import { env, hooks, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

type ConsumedPushJob = {
  ack: number;
  retry: number;
  sent: { body: MailboxPushJob }[][];
};

/** One job through the Worker's push consumer, with the push queue's producer recorded. */
function consumePushJob(
  body: MailboxPushJob,
  options: { vapid?: Record<string, string>; failFetch?: string } = {}
) {
  return hooks.call<ConsumedPushJob>("realtime.consumePushJob", body, options);
}

async function registerPushTarget() {
  const { VAPID_PUBLIC_KEY } = await hooks.env("VAPID_PUBLIC_KEY");

  let authentication = await worker.fetch(
    new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Push Admin", email: "push@example.test" }),
    })
  );

  if (authentication.status === 409) {
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE name = 'Push Admin' LIMIT 1"
    ).first<{ id: string }>();

    const { id: userId } = required(user, "the push admin exists");
    authentication = await worker.fetch(
      new Request("http://example.test/api/auth/mock/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      })
    );
  }

  expect(authentication.status).toBe(200);
  const cookie = sessionCookie(authentication);

  const mailboxResponse = await worker.fetch(
    new Request("http://example.test/api/mail/mailboxes", {
      headers: { cookie },
    })
  );

  const body = await readJson(
    mailboxResponse,
    z.object({ mailboxes: z.array(z.looseObject({ id: z.string() })) })
  );

  const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;

  const registration = await worker.fetch(
    new Request("http://example.test/api/notifications/subscriptions", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        endpoint,
        keys: {
          p256dh: VAPID_PUBLIC_KEY,
          auth: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      }),
    })
  );

  expect(registration.status).toBe(200);

  const [first] = body.mailboxes;

  const subscription = required(
    await env.DB.prepare(
      "SELECT id, session_id AS sessionId FROM push_subscriptions WHERE endpoint = ?"
    )
      .bind(endpoint)
      .first<{ id: string; sessionId: string }>(),
    "the device's subscription is stored"
  );

  return {
    mailboxId: required(first, "the push admin has a mailbox").id,
    endpoint,
    subscriptionId: subscription.id,
    sessionId: subscription.sessionId,
  };
}

function deliverJob(
  mailboxId: string,
  targetSubscriptionId: string
): MailboxPushJob {
  return {
    type: "deliver",
    mailboxId,
    conversationId: "conv_push_deliver",
    messageId: `msg_${crypto.randomUUID()}`,
    occurredAt: Date.now(),
    sender: "Sender",
    subject: "Delivered",
    targetSubscriptionId,
    mailboxDisplayName: "Mailbox",
  };
}

describe("push notification jobs", () => {
  it("drops notifications that are already older than 15 minutes", async () => {
    expect((await hooks.env("VAPID_PUBLIC_KEY")).VAPID_PUBLIC_KEY).toBeTruthy();

    const { outcomes } = await hooks.queue(emailQueueRoles.pushNotifications, [
      {
        body: {
          type: "dispatch",
          mailboxId: "mbx_stale_push",
          conversationId: "conv_stale_push",
          messageId: "msg_stale_push",
          occurredAt: Date.now() - 15 * 60 * 1000 - 1,
          sender: "Sender",
          subject: "Stale notification",
        },
      },
    ]);

    expect(outcomes).toEqual([{ ack: true, retry: false }]);
  });

  it("keeps fanning out to devices whose session expired, and to unbound ones", async () => {
    const expired = await registerPushTarget();
    const unbound = await registerPushTarget();
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expired.sessionId)
      .run();
    // A row registered before subscriptions were bound to a session.
    await env.DB.prepare(
      "UPDATE push_subscriptions SET session_id = NULL WHERE id = ?"
    )
      .bind(unbound.subscriptionId)
      .run();

    const queued = await consumePushJob({
      type: "dispatch",
      mailboxId: expired.mailboxId,
      conversationId: "conv_push_dispatch",
      messageId: "msg_push_dispatch",
      occurredAt: Date.now(),
      sender: "Sender",
      subject: "Queued separately",
    });

    expect(queued.ack).toBe(1);
    expect(queued.retry).toBe(0);
    expect(queued.sent).toHaveLength(1);

    const targets = (queued.sent[0] ?? []).map(({ body }) =>
      body.type === "deliver" ? body.targetSubscriptionId : null
    );

    expect(targets.toSorted()).toEqual(
      [expired.subscriptionId, unbound.subscriptionId].toSorted()
    );
    expect(queued.sent[0]?.[0]).toEqual({
      body: expect.objectContaining({
        type: "deliver",
        mailboxId: expired.mailboxId,
        messageId: "msg_push_dispatch",
        mailboxDisplayName: expect.any(String),
      }),
    });
  });

  it("drops a stored subscription whose endpoint is not a public HTTPS URL", async () => {
    const { VAPID_PUBLIC_KEY } = await hooks.env("VAPID_PUBLIC_KEY");
    const { mailboxId } = await registerPushTarget();

    const userId = required(
      await env.DB.prepare(
        "SELECT id FROM users WHERE name = 'Push Admin' LIMIT 1"
      ).first<{ id: string }>(),
      "the push admin exists"
    ).id;

    const subscriptionId = `push_${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(
        subscriptionId,
        userId,
        "https://10.0.0.5/relay",
        VAPID_PUBLIC_KEY,
        "AAAAAAAAAAAAAAAAAAAAAA"
      )
      .run();

    internet.reset();

    const queued = await consumePushJob(deliverJob(mailboxId, subscriptionId));

    expect(queued.ack).toBe(1);
    expect(internet.requests).toEqual([]);
    expect(
      await env.DB.prepare("SELECT id FROM push_subscriptions WHERE id = ?")
        .bind(subscriptionId)
        .first()
    ).toBeNull();
  });

  it("keeps a subscription after a local delivery error", async () => {
    const { mailboxId, subscriptionId } = await registerPushTarget();

    const queued = await consumePushJob(
      {
        type: "deliver",
        mailboxId,
        conversationId: "conv_push_local_error",
        messageId: "msg_push_local_error",
        occurredAt: Date.now(),
        sender: "Sender",
        subject: "Local failure",
        targetSubscriptionId: subscriptionId,
        mailboxDisplayName: "Mailbox",
      },
      { failFetch: "Local push failure" }
    );

    expect(queued.ack).toBe(1);
    expect(queued.retry).toBe(0);
    await expect(
      env.DB.prepare("SELECT id FROM push_subscriptions WHERE id = ?")
        .bind(subscriptionId)
        .first()
    ).resolves.toBeTruthy();
  });

  it("acknowledges jobs without fanout when the VAPID config is invalid", async () => {
    const queued = await consumePushJob(
      {
        type: "dispatch",
        mailboxId: "mbx_invalid_vapid",
        conversationId: "conv_invalid_vapid",
        messageId: "msg_invalid_vapid",
        occurredAt: Date.now(),
        sender: "Sender",
        subject: "Invalid config",
      },
      {
        vapid: {
          VAPID_PUBLIC_KEY: "invalid",
          VAPID_PRIVATE_KEY: "invalid",
          VAPID_SUBJECT: "invalid",
        },
      }
    );

    expect(queued.ack).toBe(1);
    expect(queued.retry).toBe(0);
    expect(queued.sent).toHaveLength(0);
  });
});
