import { describe, expect, it } from "bun:test";

import { inboundDeliveryId } from "@open-workspace/email/worker/mail/inbound-delivery.ts";

const encoder = new TextEncoder();

describe("inbound delivery identity", () => {
  it("is stable for a replay and scoped by envelope and content", async () => {
    const input = {
      mailboxId: "mbx_test",
      envelopeFrom: "SENDER@Example.NET",
      envelopeTo: "Inbox@Example.TEST",
      raw: encoder.encode("Subject: Hello\r\n\r\nBody").buffer,
    };

    const first = await inboundDeliveryId(input);

    await expect(
      inboundDeliveryId({
        ...input,
        envelopeFrom: "SENDER@example.net",
        envelopeTo: "inbox@example.test",
      })
    ).resolves.toBe(first);
    await expect(
      inboundDeliveryId({
        ...input,
        envelopeFrom: "sender@example.net",
      })
    ).resolves.not.toBe(first);
    await expect(
      inboundDeliveryId({
        ...input,
        raw: encoder.encode("Subject: Hello\r\n\r\nDifferent body").buffer,
      })
    ).resolves.not.toBe(first);
  });
});
