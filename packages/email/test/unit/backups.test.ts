import { describe, expect, it } from "bun:test";

import { serializeEml } from "@open-workspace/email/worker/backups/eml.ts";
import PostalMime from "postal-mime";

const sent = {
  id: "eml_1",
  from: [{ address: "ada@example.test", name: 'Ada "the" Moss' }],
  to: [{ address: "rosa@fernhollow.example", name: "Rosa Grüße" }],
  cc: [],
  bcc: [{ address: "audit@example.test", name: null }],
  replyTo: [],
  subject: "Glaze order – Grüße\r\nBcc: injected@example.test",
  date: new Date("2026-03-03T10:00:00Z"),
  messageId: "<eml_1@example.test>",
  inReplyTo: ["<m1@fernhollow.example>"],
  references: ["<m0@fernhollow.example>", "<m1@fernhollow.example>"],
  text: "Two kilos of celadon, please.",
  html: "<p>Two kilos of <b>celadon</b>, please.</p>",
  attachments: [
    {
      disposition: "attachment" as const,
      filename: "order.pdf",
      type: "application/pdf",
      content: new TextEncoder().encode("%PDF-1.4 order").buffer,
    },
    {
      disposition: "inline" as const,
      contentId: "logo",
      filename: "logo.png",
      type: "image/png",
      content: new Uint8Array([137, 80, 78, 71]).buffer,
    },
  ],
};

describe("backup MIME for sent mail", () => {
  it("parses back to the same message", async () => {
    const parsed = await PostalMime.parse(serializeEml(sent));

    expect(parsed.from).toEqual({
      address: "ada@example.test",
      name: 'Ada "the" Moss',
    });
    expect(parsed.to).toEqual([
      { address: "rosa@fernhollow.example", name: "Rosa Grüße" },
    ]);
    expect(parsed.bcc).toEqual([{ address: "audit@example.test", name: "" }]);
    // CR/LF in a stored value never starts a header of its own.
    expect(parsed.subject).toBe(
      "Glaze order – Grüße Bcc: injected@example.test"
    );
    expect(
      parsed.headers.filter((header) => header.key === "bcc")
    ).toHaveLength(1);
    expect(parsed.messageId).toBe("<eml_1@example.test>");
    expect(parsed.inReplyTo).toBe("<m1@fernhollow.example>");
    expect(parsed.date).toBe("2026-03-03T10:00:00.000Z");
    expect(parsed.text?.trim()).toBe(sent.text);
    expect(parsed.html).toBe(sent.html);
    expect(
      parsed.attachments.map((item) => [
        item.filename,
        item.mimeType,
        item.disposition,
        item.contentId ?? null,
      ])
    ).toEqual([
      ["order.pdf", "application/pdf", "attachment", null],
      ["logo.png", "image/png", "inline", "<logo>"],
    ]);
  });

  it("writes the same bytes every time, so backups deduplicate", () => {
    expect(serializeEml(sent)).toEqual(serializeEml(sent));
  });
});
