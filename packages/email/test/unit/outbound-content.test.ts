import { describe, expect, it } from "bun:test";

import { linkedAttachmentTextToken } from "@open-workspace/email/shared/mail.ts";
import {
  appendForwardedMessage,
  contextForNewRecipient,
  externalizeLinkedInlineImages,
  resolveLinkedAttachmentPlaceholders,
  textWithQuotedContext,
} from "@open-workspace/email/worker/mail/outbound-content.ts";
import type { MailAddress } from "@open-workspace/email/worker/mailbox/model.ts";

const address = (value: string): MailAddress => ({
  address: value,
  name: null,
});

const source = {
  fromJson: [address("author@example.net")],
  toJson: [address("me@example.test")],
  ccJson: [],
  subject: "Original subject",
  timelineAt: new Date("2026-07-23T10:00:00Z"),
  bodyText: "Original body",
  preview: "Original body",
};

describe("outbound message content", () => {
  it("serializes a forwarded message into the outgoing body", () => {
    const result = appendForwardedMessage("Please review.", undefined, source);
    expect(result.bodyText).toContain("Please review.\n\nForwarded message");
    expect(result.bodyText).toContain("From: author@example.net");
    expect(result.bodyText).toContain("Original body");
  });

  it("keeps participant context separate until SMTP serialization", () => {
    const context = contextForNewRecipient(source);
    expect(textWithQuotedContext("Welcome.", context)).toContain(
      "Welcome.\n\n> From: author@example.net"
    );
    expect(textWithQuotedContext("No quote.", null)).toBe("No quote.");
  });

  it("replaces an externalized CID image with its download link", () => {
    const result = externalizeLinkedInlineImages(
      '<p>Preview</p><img src="cid:inline-image@example.test" alt="Chart">',
      [
        {
          disposition: "inline",
          contentId: "inline-image@example.test",
          filename: "chart.png",
          downloadUrl: "https://mail.example.test/download/chart",
        },
      ]
    );

    expect(result).not.toContain("<img");
    expect(result).toContain(
      '<a href="https://mail.example.test/download/chart">chart.png</a>'
    );
  });

  it("resolves a linked attachment where the composer placed its block", () => {
    const uploadId = "upl_0123456789abcdef0123456789abcdef";

    const result = resolveLinkedAttachmentPlaceholders({
      bodyText: ["Before", linkedAttachmentTextToken(uploadId), "After"].join(
        "\n\n"
      ),
      bodyHtml: [
        "<p>Before</p>",
        `<span data-linked-attachment="${uploadId}">report.pdf</span>`,
        "<p>After</p>",
      ].join(""),
      attachments: [
        {
          uploadId,
          filename: "report.pdf",
          downloadUrl: "https://mail.example.test/download/report",
        },
      ],
    });

    expect(result.bodyText).toBe(
      "Before\n\nreport.pdf: https://mail.example.test/download/report\n\nAfter"
    );
    expect(result.bodyHtml).toMatch(
      /<p>Before<\/p><span data-linked-attachment-card[^>]*><a href="https:\/\/mail\.example\.test\/download\/report"[^>]*>.*report\.pdf.*<\/a><\/span><p>After<\/p>/u
    );
    expect([...result.textPlacedUploadIds]).toEqual([uploadId]);
    expect([...result.htmlPlacedUploadIds]).toEqual([uploadId]);
  });

  it("removes a stale link block when the server can attach the file", () => {
    const uploadId = "upl_0123456789abcdef0123456789abcdef";

    const result = resolveLinkedAttachmentPlaceholders({
      bodyText: `Before\n\n${linkedAttachmentTextToken(uploadId)}\n\nAfter`,
      bodyHtml: `<p>Before<span data-linked-attachment="${uploadId}">small.txt</span>After</p>`,
      attachments: [
        {
          uploadId,
          filename: "small.txt",
          downloadUrl: null,
        },
      ],
    });

    expect(result.bodyText).toBe("Before\n\nAfter");
    expect(result.bodyHtml).toBe("<p>BeforeAfter</p>");
  });

  it("scrubs unresolved composer attachment markers", () => {
    const uploadId = "upl_0123456789abcdef0123456789abcdef";

    const result = resolveLinkedAttachmentPlaceholders({
      bodyText: `Before\n\n${linkedAttachmentTextToken(uploadId)}\n\nAfter`,
      bodyHtml: `<p>Before</p><span data-linked-attachment="${uploadId}">missing.txt</span><p>After</p>`,
      attachments: [],
    });

    expect(result.bodyText).toBe("Before\n\nAfter");
    expect(result.bodyHtml).toBe("<p>Before</p><p>After</p>");
  });
});
