import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { MailboxPushJob } from "../shared/mail";
import type { PushBindings } from "../worker/env";
import { consumePushNotifications } from "../worker/mail/push-notifications";

function queueBatch(body: unknown) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    ack,
    retry,
    batch: {
      queue: "openworkspace-push-notifications",
      messages: [{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        body,
        attempts: 1,
        ack,
        retry,
      }],
      metadata: {
        metrics: {
          backlogCount: 1,
          backlogBytes: 1,
        },
      },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies MessageBatch<unknown>,
  };
}

function envWithQueue(
  sendBatch: (messages: MessageSendRequest<MailboxPushJob>[]) => Promise<void>,
  vapid: PushBindings = {},
) {
  return {
    DB: env.DB,
    MAILBOX: env.MAILBOX,
    PUSH_NOTIFICATIONS: { sendBatch },
    VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY ?? env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: vapid.VAPID_PRIVATE_KEY ?? env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: vapid.VAPID_SUBJECT ?? env.VAPID_SUBJECT,
  } as unknown as Env & PushBindings;
}

async function registerPushTarget() {
  let authentication = await exports.default.fetch(
    new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Push Admin", email: "push@example.test" }),
    }),
  );
  if (authentication.status === 409) {
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE name = 'Push Admin' LIMIT 1",
    ).first<{ id: string }>();
    expect(user).toBeTruthy();
    authentication = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: user!.id }),
      }),
    );
  }
  expect(authentication.status).toBe(200);
  const cookie = authentication.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const mailboxResponse = await exports.default.fetch(
    new Request("http://example.test/api/mail/mailboxes", {
      headers: { cookie: cookie! },
    }),
  );
  const body = await mailboxResponse.json() as {
    mailboxes: Array<{ id: string }>;
  };
  const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
  const registration = await exports.default.fetch(
    new Request("http://example.test/api/notifications/subscriptions", {
      method: "PUT",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({
        endpoint,
        keys: {
          p256dh: env.VAPID_PUBLIC_KEY,
          auth: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      }),
    }),
  );
  expect(registration.status).toBe(200);
  return { mailboxId: body.mailboxes[0]!.id, endpoint };
}

describe("push notification jobs", () => {
  it("drops notifications that are already older than 15 minutes", async () => {
    expect(env.VAPID_PUBLIC_KEY).toBeTruthy();
    const queued = queueBatch({
      type: "dispatch",
      mailboxId: "mbx_stale_push",
      conversationId: "conv_stale_push",
      messageId: "msg_stale_push",
      occurredAt: Date.now() - 15 * 60 * 1_000 - 1,
      sender: "Sender",
      subject: "Stale notification",
    });

    await consumePushNotifications(queued.batch, env);

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("fans out to a device after its sign-in session expires", async () => {
    const { mailboxId } = await registerPushTarget();
    await env.DB.prepare("UPDATE sessions SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    const sendBatch = vi.fn(async (
      _messages: MessageSendRequest<MailboxPushJob>[],
    ) => undefined);
    const queued = queueBatch({
      type: "dispatch",
      mailboxId,
      conversationId: "conv_push_dispatch",
      messageId: "msg_push_dispatch",
      occurredAt: Date.now(),
      sender: "Sender",
      subject: "Queued separately",
    });

    await consumePushNotifications(queued.batch, envWithQueue(sendBatch));

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(sendBatch.mock.calls[0]![0]).toEqual([
      {
        body: expect.objectContaining({
          type: "deliver",
          mailboxId,
          messageId: "msg_push_dispatch",
          targetSubscriptionId: expect.any(String),
          mailboxDisplayName: expect.any(String),
        }),
      },
    ]);
  });

  it("keeps a subscription after a local delivery error", async () => {
    const { mailboxId, endpoint } = await registerPushTarget();
    const subscription = await env.DB.prepare(
      "SELECT id FROM push_subscriptions WHERE endpoint = ?",
    ).bind(endpoint).first<{ id: string }>();
    expect(subscription).toBeTruthy();
    const queued = queueBatch({
      type: "deliver",
      mailboxId,
      conversationId: "conv_push_local_error",
      messageId: "msg_push_local_error",
      occurredAt: Date.now(),
      sender: "Sender",
      subject: "Local failure",
      targetSubscriptionId: subscription!.id,
      mailboxDisplayName: "Mailbox",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Local push failure");
    }));

    try {
      await consumePushNotifications(queued.batch, envWithQueue(async () => undefined));
      expect(queued.ack).toHaveBeenCalledOnce();
      expect(queued.retry).not.toHaveBeenCalled();
      await expect(
        env.DB.prepare(
          "SELECT id FROM push_subscriptions WHERE id = ?",
        ).bind(subscription!.id).first(),
      ).resolves.toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
      consoleError.mockRestore();
    }
  });

  it("acknowledges jobs without fanout when the VAPID config is invalid", async () => {
    const sendBatch = vi.fn(async (
      _messages: MessageSendRequest<MailboxPushJob>[],
    ) => undefined);
    const queued = queueBatch({
      type: "dispatch",
      mailboxId: "mbx_invalid_vapid",
      conversationId: "conv_invalid_vapid",
      messageId: "msg_invalid_vapid",
      occurredAt: Date.now(),
      sender: "Sender",
      subject: "Invalid config",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await consumePushNotifications(queued.batch, envWithQueue(sendBatch, {
      VAPID_PUBLIC_KEY: "invalid",
      VAPID_PRIVATE_KEY: "invalid",
      VAPID_SUBJECT: "invalid",
    }));

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
