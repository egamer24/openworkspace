import { describe, expect, it } from "bun:test";

import { linkedAttachmentTextToken } from "@open-workspace/email/shared/mail.ts";
import type { prepareOutgoingEmail } from "@open-workspace/email/worker/mail/outbound.ts";
import { composeSchema } from "@open-workspace/email/worker/mail/schemas.ts";
import { composerUploadKey } from "@open-workspace/email/worker/mail/uploads.ts";

import { unwrap, uploads } from "./mail-flow-helpers.ts";
import { env, hooks, useFreshWorkspace } from "./workspace.ts";

useFreshWorkspace();

// outbound.ts and uploads.ts run in the Worker (hooks/mail-flow.ts).
type Upload = { id: string; r2Key: string };

type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: { name: string; message: string } };

async function createFinalizedUpload(input: {
  mailboxId: string;
  userId: string;
  filename: string;
  contentType: string;
  body: string;
}) {
  const intent = await uploads<{ id: string }>({
    fn: "createIntent",
    input: {
      mailboxId: input.mailboxId,
      userId: input.userId,
      filename: input.filename,
      contentType: input.contentType,
      size: new TextEncoder().encode(input.body).byteLength,
    },
  });

  await env.MAIL_STORAGE.put(
    composerUploadKey(input.mailboxId, input.userId, intent.id),
    input.body
  );

  return uploads<Upload>({
    fn: "finalize",
    input: {
      mailboxId: input.mailboxId,
      userId: input.userId,
      uploadId: intent.id,
    },
  });
}

const discardUploads = (
  mailboxId: string,
  userId: string,
  uploadIds: string[]
) => uploads({ fn: "discard", input: { mailboxId, userId, uploadIds } });

/** prepareOutgoingEmail's input; the hook supplies the Worker's bindings. */
type PrepareInput = Omit<Parameters<typeof prepareOutgoingEmail>[0], "env">;

async function prepare(
  input: PrepareInput,
  options: { failPutSuffix?: string } = {}
) {
  return unwrap(
    await hooks.call<Outcome<{ preview: string; storageKeys: string[] }>>(
      "mailFlow.outbound.prepare",
      input,
      options
    )
  );
}

describe("outbound object rollback", () => {
  it("returns after persistence while composer cleanup runs in the background", async () => {
    const mailboxId = `mbx_cleanup_${crypto.randomUUID()}`;
    const userId = `usr_cleanup_${crypto.randomUUID()}`;

    const upload = await createFinalizedUpload({
      mailboxId,
      userId,
      filename: "cleanup.txt",
      contentType: "text/plain",
      body: "cleanup",
    });

    // submitOutgoing runs with the bucket's deletes held, then a replay of it.
    const result = await hooks.call<{
      raced: "returned" | "timeout";
      deferredFirst: number;
      replayInserted?: boolean;
      deferredAfterReplay: number;
    }>(
      "mailFlow.outbound.submitWithBlockedCleanup",
      {
        requestUrl: "https://mail.example.test",
        fromAddress: "sender@example.test",
        fromName: "Sender",
        compose: {
          requestId: crypto.randomUUID(),
          mailboxId,
          userId,
          to: ["recipient@example.test"],
          cc: [],
          bcc: [],
          subject: "Background cleanup",
          bodyText: "Authored content",
          attachments: [{ uploadId: upload.id, disposition: "attachment" }],
        },
        conversationId: `conv_${crypto.randomUUID()}`,
        related: null,
        forwarded: null,
        includeRelatedContext: false,
      },
      500
    );

    expect(result.raced).not.toBe("timeout");
    expect(result.deferredFirst).toBeGreaterThanOrEqual(1);
    expect(result.replayInserted).toBe(false);
    expect(result.deferredAfterReplay).toBeGreaterThan(result.deferredFirst);
  });

  it("rejects non-image uploads submitted as inline content", async () => {
    const mailboxId = `mbx_inline_${crypto.randomUUID()}`;
    const userId = `usr_inline_${crypto.randomUUID()}`;

    const upload = await createFinalizedUpload({
      mailboxId,
      userId,
      filename: "document.txt",
      contentType: "text/plain",
      body: "not an image",
    });

    const uploadId = upload.id;

    const parsed = composeSchema.parse({
      requestId: crypto.randomUUID(),
      mailboxId,
      to: ["recipient@example.test"],
      bodyText: "See attached file",
      attachments: [
        {
          uploadId,
          disposition: "inline",
          contentId: "document@example.test",
        },
      ],
    });

    try {
      await expect(
        prepare({
          requestUrl: "https://mail.example.test",
          compose: { ...parsed, userId },
          requestFingerprint: "inline-validation-fingerprint",
          id: `msg_inline_${crypto.randomUUID()}`,
          conversationId: `conv_${crypto.randomUUID()}`,
          related: null,
          forwarded: null,
          includeRelatedContext: false,
          fromAddress: "sender@example.test",
          fromName: "Sender",
          now: new Date("2026-07-27T00:00:00Z"),
        })
      ).rejects.toThrow("Inline images must be PNG, JPEG, GIF, or WebP");
    } finally {
      await discardUploads(mailboxId, userId, [uploadId]);
    }
  });

  it("waits for every attempted write before removing a failed attempt", async () => {
    const mailboxId = `mbx_rollback_${crypto.randomUUID()}`;
    const userId = `usr_rollback_${crypto.randomUUID()}`;

    const upload = await createFinalizedUpload({
      mailboxId,
      userId,
      filename: "attachment.txt",
      contentType: "text/plain",
      body: "attachment",
    });

    const uploadId = upload.id;
    const sourceKey = upload.r2Key;
    const messageId = `msg_rollback_${crypto.randomUUID()}`;
    const attemptPrefix = `mailboxes/${mailboxId}/messages/${messageId}/attempts/`;

    const parsed = composeSchema.parse({
      requestId: crypto.randomUUID(),
      mailboxId,
      to: ["recipient@example.test"],
      bodyText: "Authored content",
      bodyHtml: "<p>Authored content</p>",
      attachments: [{ uploadId }],
    });

    try {
      // The bucket fails the HTML body's write; the other writes go through.
      await expect(
        prepare(
          {
            requestUrl: "https://mail.example.test",
            compose: { ...parsed, userId },
            requestFingerprint: "rollback-fingerprint",
            id: messageId,
            conversationId: `conv_${crypto.randomUUID()}`,
            related: null,
            forwarded: null,
            includeRelatedContext: false,
            fromAddress: "sender@example.test",
            fromName: "Sender",
            now: new Date("2026-07-27T00:00:00Z"),
          },
          { failPutSuffix: "/body.html" }
        )
      ).rejects.toThrow("Simulated HTML write failure");

      expect(
        (await env.MAIL_STORAGE.list({ prefix: attemptPrefix })).objects
      ).toHaveLength(0);
      expect(await env.MAIL_STORAGE.head(sourceKey)).not.toBeNull();
    } finally {
      await discardUploads(mailboxId, userId, [uploadId]);
    }
  });

  it("builds preview after resolving composer attachment markers", async () => {
    const mailboxId = `mbx_preview_${crypto.randomUUID()}`;
    const userId = `usr_preview_${crypto.randomUUID()}`;

    const upload = await createFinalizedUpload({
      mailboxId,
      userId,
      filename: "preview.txt",
      contentType: "text/plain",
      body: "preview attachment",
    });

    const token = linkedAttachmentTextToken(upload.id);

    const parsed = composeSchema.parse({
      requestId: crypto.randomUUID(),
      mailboxId,
      to: ["recipient@example.test"],
      bodyText: token,
      bodyHtml: `<p><span data-linked-attachment="${upload.id}">preview.txt</span></p>`,
      attachments: [{ uploadId: upload.id }],
    });

    let prepared: { preview: string; storageKeys: string[] } | null = null;

    try {
      prepared = await prepare({
        requestUrl: "https://mail.example.test",
        compose: { ...parsed, userId },
        requestFingerprint: "preview-fingerprint",
        id: `msg_preview_${crypto.randomUUID()}`,
        conversationId: `conv_${crypto.randomUUID()}`,
        related: null,
        forwarded: null,
        includeRelatedContext: false,
        fromAddress: "sender@example.test",
        fromName: "Sender",
        now: new Date("2026-07-27T00:00:00Z"),
      });

      expect(prepared.preview).toBe("");
      expect(prepared.preview).not.toContain("openworkspace-attachment");
    } finally {
      if (prepared) {
        await hooks.call(
          "mailFlow.outbound.discardPrepared",
          prepared.storageKeys
        );
      }

      await discardUploads(mailboxId, userId, [upload.id]);
    }
  });
});
