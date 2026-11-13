import { describe, expect, it } from "bun:test";

import { createDb, mailboxes } from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import { eq } from "drizzle-orm";

import { emailQueueRoles } from "../../shared/module.ts";
import type { JsonValue } from "./json.ts";
import {
  env,
  hooks,
  mailbox as mailboxObject,
  useFreshWorkspace,
  worker,
} from "./workspace.ts";

useFreshWorkspace();

/** Runs the Worker's queue handler on the event, as the delivery events queue hands it over. */
async function consume(body: JsonValue) {
  const { outcomes, error } = await hooks.queue(
    emailQueueRoles.deliveryEvents,
    [{ body }]
  );

  expect(error).toBeUndefined();

  return required(outcomes[0], "the batch has an outcome for its message");
}

describe("Email Service delivery events", () => {
  it("updates one recipient idempotently by Cloudflare message ID", async () => {
    const bootstrap = await worker.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
      })
    );

    expect(bootstrap.status).toBe(200);
    await bootstrap.json();

    const [mailbox] = await createDb(env.DB)
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.isPrimary, true))
      .limit(1);

    const stub = mailboxObject(
      required(mailbox, "bootstrap made a primary mailbox").id
    );

    await stub.insertEmail({
      id: "msg_delivery_event",
      conversationId: "conv_delivery_event",
      direction: "outgoing",
      messageIdHeader: "cf-message-123",
      fromJson: [{ address: "admin@example.test", name: "Admin" }],
      toJson: [{ address: "recipient@example.net", name: null }],
      subject: "Delivery event",
      timelineAt: new Date(),
      transportState: "submitted",
    });

    const event = {
      type: "cf.email.sending.message.delivered",
      source: { type: "email.sending", domain: "example.test" },
      payload: {
        eventId: "event-delivered-1",
        messageId: "cf-message-123",
        sender: "admin@example.test",
        recipient: "recipient@example.net",
        subject: "Delivery event",
        terminal: true,
        delivery: {
          status: "delivered",
          provider: "example",
          smtpStatusCode: "250",
          smtpResponse: "250 OK",
        },
      },
      metadata: {
        accountId: "account",
        eventSubscriptionId: "subscription",
        eventSchemaVersion: 1,
        eventTimestamp: "2026-07-23T12:00:00.000Z",
      },
    };

    expect(await consume(event)).toMatchObject({ ack: true, retry: false });

    expect(await consume(event)).toMatchObject({ ack: true });
    const stored = await stub.getEmail("msg_delivery_event");
    expect(stored?.deliveryStatusJson).toEqual([
      expect.objectContaining({
        recipient: "recipient@example.net",
        status: "delivered",
        eventId: "event-delivered-1",
        smtpCode: "250",
      }),
    ]);
  });
});
