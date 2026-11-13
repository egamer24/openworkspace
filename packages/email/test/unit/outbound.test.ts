import { describe, expect, it } from "bun:test";

import {
  normalizeEmail,
  normalizeMailboxAddress,
} from "@open-workspace/core/module";
import {
  composerAttachmentLimitError,
  linkedAttachmentTextToken,
} from "@open-workspace/email/shared/mail.ts";
import { emailDestinations } from "@open-workspace/email/worker/mail/outbound-delivery.ts";
import {
  attachmentsRequiringDownloadLinks,
  messageIdForRequest,
  withDownloadLinks,
} from "@open-workspace/email/worker/mail/outbound.ts";
import {
  boundedMessageIds,
  replyThreadHeaders,
} from "@open-workspace/email/worker/mail/rfc.ts";
import {
  composeSchema,
  replySchema,
} from "@open-workspace/email/worker/mail/schemas.ts";

describe("outbound email limits", () => {
  it("externalizes only as many large attachments as needed for the 5 MiB MIME limit", () => {
    const linked = attachmentsRequiringDownloadLinks({
      subject: "Quarterly files",
      bodyText: "See attachments.",
      attachments: [
        { id: "largest", size: 3_200_000 },
        { id: "smaller", size: 2_000_000 },
      ],
    });

    expect([...linked]).toEqual(["largest"]);
  });

  it("counts forwarded and newly uploaded attachments in one composer limit", () => {
    expect(
      composerAttachmentLimitError([
        ...Array.from({ length: 10 }, () => ({ size: 1 })),
        { size: 1 },
      ])
    ).toBe("Use at most 10 attachments");
  });

  it("keeps a positioned download link out of the appended fallback list", () => {
    const uploadId = "upl_0123456789abcdef0123456789abcdef";
    const downloadUrl = "https://mail.example.test/download/report";

    const result = withDownloadLinks(
      `Before\n\n${linkedAttachmentTextToken(uploadId)}\n\nAfter`,
      `<p>Before<span data-linked-attachment="${uploadId}">report.pdf</span>After</p>`,
      [
        {
          id: "att_1",
          r2Key: "messages/one/attachments/att_1",
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 4_000_000,
          contentId: null,
          disposition: "attachment",
          delivery: "download_link",
          downloadTokenHash: "hash",
          downloadExpiresAt: Date.UTC(2026, 7, 26),
          downloadUrl,
          sourceUploadId: uploadId,
        },
      ],
      new Date("2026-07-27T00:00:00Z")
    );

    expect(result.bodyText).toContain(`report.pdf: ${downloadUrl}`);
    expect(result.bodyText).not.toContain("Attachments (download links");
    expect(
      result.bodyHtml?.match(
        /https:\/\/mail\.example\.test\/download\/report/gu
      )
    ).toHaveLength(1);
  });

  it("enforces the provider's combined 50-recipient limit", () => {
    const result = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      to: Array.from({ length: 25 }, (_, index) => `to${index}@example.test`),
      cc: Array.from({ length: 25 }, (_, index) => `cc${index}@example.test`),
      bcc: ["hidden@example.test"],
    });

    expect(result.success).toBe(false);
  });

  it("accepts a Bcc-only message", () => {
    const result = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      bcc: ["hidden@example.test"],
      bodyText: "Hello",
    });

    expect(result.success).toBe(true);
    expect(
      emailDestinations({
        toJson: [],
        ccJson: [],
        bccJson: [{ address: "hidden@example.test", name: null }],
      })
    ).toEqual({ bcc: ["hidden@example.test"] });
  });

  it("preserves external local-part case and deduplicates recipient roles", () => {
    const result = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      to: ["Person@Example.NET", "Person@example.net"],
      cc: ["Person@example.net", "copy@Example.NET"],
      bcc: ["copy@example.net", "hidden@Example.NET"],
      bodyText: "Hello",
    });

    expect(result.success).toBe(true);

    if (!result.success) return;
    expect(result.data).toMatchObject({
      to: ["Person@example.net"],
      cc: ["copy@example.net"],
      bcc: ["hidden@example.net"],
    });
    expect(normalizeEmail("Person@Example.NET")).toBe("Person@example.net");
    expect(normalizeMailboxAddress("Person@Example.NET")).toBe(
      "person@example.net"
    );
  });

  it("accepts attachment upload refs without base64 payloads", () => {
    const result = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      to: ["recipient@example.test"],
      bodyText: "See attached file",
      attachments: [
        {
          uploadId: "upl_0123456789abcdef0123456789abcdef",
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("requires a content ID only for inline uploads", () => {
    const valid = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      to: ["recipient@example.test"],
      bodyText: "See inline image",
      attachments: [
        {
          uploadId: "upl_0123456789abcdef0123456789abcdef",
          disposition: "inline",
          contentId: "inline-image@example.test",
        },
      ],
    });

    const missing = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      to: ["recipient@example.test"],
      attachments: [
        {
          uploadId: "upl_0123456789abcdef0123456789abcdef",
          disposition: "inline",
        },
      ],
    });

    expect(valid.success).toBe(true);
    expect(missing.success).toBe(false);
  });

  it("rejects duplicate attachment upload refs", () => {
    const uploadId = "upl_0123456789abcdef0123456789abcdef";

    const result = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      to: ["recipient@example.test"],
      bodyText: "See attached file",
      attachments: [{ uploadId }, { uploadId }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a message containing only attachments before provider submission", () => {
    const result = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      to: ["recipient@example.test"],
      attachments: [{ uploadId: "upl_0123456789abcdef0123456789abcdef" }],
    });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          message: "Add text to the message before sending",
        })
      );
    }
  });

  it("rejects an empty reply with an attachment", () => {
    const result = replySchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      mode: "reply",
      attachments: [{ uploadId: "upl_0123456789abcdef0123456789abcdef" }],
    });

    expect(result.success).toBe(false);
  });

  it("keeps only the newest References within provider limits", () => {
    const references = boundedMessageIds(
      Array.from(
        { length: 140 },
        (_, index) => `<message-${index}@example.test>`
      )
    );

    expect(references).toHaveLength(100);
    expect(references[0]).toBe("<message-40@example.test>");
    expect(references.at(-1)).toBe("<message-139@example.test>");
    expect(
      new TextEncoder().encode(references.join(" ")).byteLength
    ).toBeLessThanOrEqual(12 * 1024);
  });

  it("derives one local message ID from a client request ID", async () => {
    const requestId = crypto.randomUUID();
    const first = await messageIdForRequest("mailbox", requestId);
    const second = await messageIdForRequest("mailbox", requestId);

    expect(second).toBe(first);
  });

  it("uses a parent's single In-Reply-To when References is absent", () => {
    expect(
      replyThreadHeaders({
        messageIdHeader: "<parent@example.test>",
        inReplyToJson: ["<grandparent@example.test>"],
        referencesJson: [],
      })
    ).toEqual({
      inReplyTo: ["<parent@example.test>"],
      references: ["<grandparent@example.test>", "<parent@example.test>"],
    });
  });
});
