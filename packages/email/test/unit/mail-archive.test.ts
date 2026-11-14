import { describe, expect, it } from "bun:test";

import {
  archiveObjectKey,
  archiveRetryDue,
  sentEml,
} from "@open-workspace/email/worker/mail/archive-object.ts";
import PostalMime from "postal-mime";

describe("mail archive", () => {
  it("files each message by month and direction", () => {
    expect(
      archiveObjectKey("incoming", "dlv_1", new Date("2026-03-31T23:59:00Z"))
    ).toBe("2026/03/incoming/dlv_1.eml");
  });

  it("retries after a minute, then 5 minutes doubling up to 6 hours", () => {
    const at = new Date("2026-03-03T10:00:00Z");
    const minutes = (value: number) => at.getTime() + value * 60_000;

    const due = (attempts: number, after: number) =>
      archiveRetryDue({ attempts, updatedAt: at }, minutes(after));

    expect(due(0, 0.5)).toBe(false);
    expect(due(0, 1)).toBe(true);
    expect(due(1, 4)).toBe(false);
    expect(due(1, 5)).toBe(true);
    expect(due(3, 19)).toBe(false);
    expect(due(3, 20)).toBe(true);
    expect(due(20, 359)).toBe(false);
    expect(due(20, 360)).toBe(true);
  });

  it("keeps a sent message as it was handed to Email Sending", async () => {
    const message = {
      from: { name: "Ada Moss", email: "ada@example.test" },
      to: "rosa@fernhollow.example",
      bcc: ["audit@example.test"],
      subject: "Auto: Glaze order",
      headers: {
        "Auto-Submitted": "auto-replied",
        "In-Reply-To": "<m1@fernhollow.example>",
      },
      text: "I'm away until Monday.",
      html: "<p>I'm away until Monday.</p>",
      attachments: [
        {
          disposition: "inline" as const,
          contentId: "logo",
          filename: "logo.png",
          type: "image/png",
          content: new Uint8Array([137, 80, 78, 71]).buffer,
        },
      ],
    };

    const sent = {
      id: "ar_1",
      date: new Date("2026-03-03T10:00:00Z"),
      messageId: "<sent-1@example.test>",
    };

    const bytes = sentEml(sent, message);
    // The same input gives the same bytes, so a retry finds its own copy.
    expect(sentEml(sent, message)).toEqual(bytes);

    const parsed = await PostalMime.parse(bytes);
    expect(parsed.from).toEqual({
      address: "ada@example.test",
      name: "Ada Moss",
    });
    expect(parsed.to).toEqual([
      { address: "rosa@fernhollow.example", name: "" },
    ]);
    expect(parsed.bcc).toEqual([{ address: "audit@example.test", name: "" }]);
    expect(parsed.messageId).toBe("<sent-1@example.test>");
    expect(parsed.inReplyTo).toBe("<m1@fernhollow.example>");
    expect(
      parsed.headers.find((header) => header.key === "auto-submitted")?.value
    ).toBe("auto-replied");
    expect(parsed.text?.trim()).toBe("I'm away until Monday.");
    expect(parsed.attachments.map((file) => file.contentId)).toEqual([
      "<logo>",
    ]);
  });
});
