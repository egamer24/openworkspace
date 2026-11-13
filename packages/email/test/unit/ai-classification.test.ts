import { describe, expect, it } from "bun:test";

import type { AiObjectRequest } from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import {
  classifyInboundEmail,
  EmailAiClassificationError,
  MAILBOX_AI_MAX_EML_BYTES,
} from "@open-workspace/email/worker/mail/ai-classification.ts";
import { z } from "zod";

const rawEmail = [
  "From: Founder <founder@example.com>",
  "To: team@example.test",
  "Subject: Product launch feedback",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="openworkspace-test"',
  "",
  "--openworkspace-test",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Launch plan: <a href="https://product.example.test/launch">notes</a></p>',
  "--openworkspace-test",
  'Content-Type: image/png; name="diagram.png"',
  "Content-Disposition: attachment; filename=diagram.png",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  "--openworkspace-test--",
].join("\r\n");

const rawMime = new TextEncoder().encode(rawEmail).buffer;
const MODEL = "openai/gpt-test";

const configuration = {
  instructions: "Route product discussions to Product.",
  confidenceThreshold: 75,
};

/** What these tests read of a model request. */
type Request = Pick<
  AiObjectRequest<never>,
  "name" | "instructions" | "content"
>;

/** A runner that answers like the AI SDK runner: validated against the request schema. */
function answer(
  value: z.core.util.JSONType,
  onRequest?: (request: Request) => void
) {
  return <T>(request: AiObjectRequest<T>) => {
    onRequest?.(request);

    // Parsed asynchronously, so a schema failure rejects like the real runner's.
    return Promise.resolve().then(() => request.schema.parse(value));
  };
}

function requestEml(request: Request | undefined) {
  return required(
    required(request, "the model was asked").content[0],
    "the request's raw message"
  );
}

/** The request's metadata part, exactly as sent: unknown keys fail the parse. */
const metadataSchema = z.strictObject({
  customFolders: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  rawMessageTruncated: z.boolean(),
  receiverSignals: z.json().optional(),
});

function requestMetadata(request: Request | undefined) {
  return metadataSchema.parse(
    JSON.parse(
      required(
        required(request, "the model was asked").content[1],
        "the request's metadata"
      )
    )
  );
}

describe("AI mail classification", () => {
  it("accepts a confident result for an existing mailbox folder", async () => {
    let request: Request | undefined;

    const result = await classifyInboundEmail({
      rawMime,
      folders: [{ id: "folder_product", name: "Product" }],
      configuration,
      model: MODEL,
      run: answer(
        {
          spam: false,
          spamConfidence: 0.98,
          folderId: "folder_product",
          folderConfidence: 0.91,
          reason: "A product discussion",
        },
        (input) => {
          request = input;
        }
      ),
      now: () => 123,
    });

    expect(result).toEqual({
      source: "ai",
      model: MODEL,
      processedAt: 123,
      spam: false,
      spamConfidence: 0.98,
      folderId: "folder_product",
      folderConfidence: 0.91,
      reason: "A product discussion",
    });
    expect(request?.name).toBe("email_classification");
    expect(request?.instructions).toContain(
      "Trusted mailbox classification rules"
    );
    expect(request?.instructions).toContain("as solicited transactional mail");
    expect(request?.instructions).toContain(
      "Treat phishing, social engineering, business-email compromise"
    );
    expect(request?.instructions).toContain(
      "Compare From, Reply-To, Message-ID, and every link hostname available"
    );
    expect(requestEml(request)).toBe(rawEmail);
    expect(requestMetadata(request)).toEqual({
      customFolders: [{ id: "folder_product", name: "Product" }],
      rawMessageTruncated: false,
    });
  });

  it("passes receiver-measured signals as trusted metadata", async () => {
    let request: Request | undefined;

    const signals = {
      authentication: {
        verdict: "suspicious" as const,
        spf: "softfail",
        dkimAlignedPass: false,
        dmarc: "fail",
        dmarcPolicy: "none",
      },
      cloudflareSpamScore: 4,
      sendingServer: {
        ip: "192.0.2.77",
        ptr: "77-2-0-192.dyn.pool.example",
        forwardConfirmed: false,
        genericPtr: true,
        heloMatchesPtr: false,
        asn: 64_511,
        asOrganization: "Bulk Hosting Ltd",
        country: "SC",
      },
      blocklists: {
        zen: ["XBL (compromised host)"],
        dbl: [{ domain: "growth-hack.invalid", list: "DBL spam domain" }],
      },
      firstTimeSender: true,
      warnings: ["dbl_listed" as const, "lookalike_domain" as const],
      userFeedback: { spamReports: 1, notSpam: 0, domainReports: 2 },
      workspaceFeedback: {
        spamReports: 3,
        notSpam: 0,
        domainReports: 0,
        reportingMailboxes: 2,
      },
      delivery: {
        deliveredTo: "maya@demo.example",
        addressedToThisMailbox: false,
        addressedTo: "someone.else@mail.example",
        knownAddressee: false,
        forwardedVia: "school.example",
      },
    };

    const result = await classifyInboundEmail({
      rawMime,
      folders: [],
      configuration,
      signals,
      model: MODEL,
      run: answer(
        {
          spam: true,
          spamConfidence: 0.96,
          folderId: null,
          folderConfidence: 0,
          reason: "Blocklisted link domain and a lookalike sender domain",
        },
        (input) => {
          request = input;
        }
      ),
      now: () => 7,
    });

    expect(result).toMatchObject({
      spam: true,
      spamConfidence: 0.96,
      folderId: null,
      processedAt: 7,
    });
    expect(request?.instructions).toContain(
      "receiverSignals were measured by this mail server"
    );
    expect(requestMetadata(request)).toEqual({
      customFolders: [],
      rawMessageTruncated: false,
      receiverSignals: signals,
    });
  });

  it("does not mention receiver signals when none are supplied", async () => {
    let request: Request | undefined;
    await classifyInboundEmail({
      rawMime,
      folders: [],
      configuration,
      model: MODEL,
      run: answer(
        {
          spam: false,
          spamConfidence: 0,
          folderId: null,
          folderConfidence: 0,
          reason: "Fine",
        },
        (input) => {
          request = input;
        }
      ),
    });
    expect(request?.instructions).not.toContain("receiverSignals");
    expect(requestMetadata(request)).not.toHaveProperty("receiverSignals");
  });

  it("omits the end of oversized raw .eml input", async () => {
    let request: Request | undefined;

    const oversizedMime = new TextEncoder().encode(
      `From: sender@example.test\r\nSubject: Large\r\n\r\nBEGIN\n${"x".repeat(
        MAILBOX_AI_MAX_EML_BYTES + 10_000
      )}\nEND`
    ).buffer;

    await classifyInboundEmail({
      rawMime: oversizedMime,
      folders: [],
      configuration,
      model: MODEL,
      run: answer(
        {
          spam: false,
          spamConfidence: 0,
          folderId: null,
          folderConfidence: 0,
          reason: "No suspicious content",
        },
        (input) => {
          request = input;
        }
      ),
    });

    const eml = requestEml(request);
    expect(eml).toHaveLength(MAILBOX_AI_MAX_EML_BYTES);
    expect(eml).toContain("BEGIN");
    expect(eml).not.toContain("END");
    expect(requestMetadata(request).rawMessageTruncated).toBe(true);
  });

  it("falls back to Inbox for unknown folders and low-confidence spam", async () => {
    const result = await classifyInboundEmail({
      rawMime,
      folders: [{ id: "folder_product", name: "Product" }],
      configuration,
      model: MODEL,
      run: answer({
        spam: true,
        spamConfidence: 0.6,
        folderId: "invented_folder",
        folderConfidence: 0.99,
        reason: "Uncertain result",
      }),
    });

    expect(result).toMatchObject({
      spam: false,
      folderId: null,
      folderConfidence: 0,
    });
  });

  it("does not assign a custom folder to accepted spam", async () => {
    const result = await classifyInboundEmail({
      rawMime,
      folders: [{ id: "folder_product", name: "Product" }],
      configuration,
      model: MODEL,
      run: answer({
        spam: true,
        spamConfidence: 0.99,
        folderId: "folder_product",
        folderConfidence: 0.99,
        reason: "Credential phishing",
      }),
    });

    expect(result).toMatchObject({
      spam: true,
      folderId: null,
      folderConfidence: 0,
    });
  });

  it("turns malformed model output into a retryable classification error", async () => {
    await expect(
      classifyInboundEmail({
        rawMime,
        folders: [],
        configuration,
        model: MODEL,
        run: answer({ response: "not json" }),
      })
    ).rejects.toBeInstanceOf(EmailAiClassificationError);
  });

  it("turns a failed model call into a retryable classification error", async () => {
    await expect(
      classifyInboundEmail({
        rawMime,
        folders: [],
        configuration,
        model: MODEL,
        run: () => Promise.reject(new Error("provider unavailable")),
      })
    ).rejects.toBeInstanceOf(EmailAiClassificationError);
  });
});
