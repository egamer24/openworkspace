import { describe, expect, it } from "bun:test";

import {
  composerUploadFinalKey,
  composerUploadKey,
  composerUploadMetaKey,
} from "@open-workspace/email/worker/mail/uploads.ts";

import { unwrap, uploads } from "./mail-flow-helpers.ts";
import { hooks, env, useFreshWorkspace } from "./workspace.ts";

useFreshWorkspace();

// uploads.ts runs in the Worker (hooks/mail-flow.ts); the keys are plain names.
type Intent = {
  id: string;
  uploadUrl: string;
  headers: Record<string, string>;
};

type Upload = { id: string; r2Key: string; filename: string; size: number };

type Ids = { mailboxId: string; userId: string };

const createIntent = (
  input: Ids & { filename: string; contentType: string; size: number }
) => uploads<Intent>({ fn: "createIntent", input });

const finalize = (input: Ids & { uploadId: string }) =>
  uploads<Upload>({ fn: "finalize", input });

const load = (input: Ids & { uploadId: string }) =>
  uploads<Upload>({ fn: "load", input });

const discard = (input: Ids & { uploadIds: string[] }) =>
  uploads({ fn: "discard", input });

describe("composer upload finalization", () => {
  it("signs direct R2 uploads for exactly the declared size", async () => {
    const mailboxId = `mbx_signed_${crypto.randomUUID()}`;
    const userId = `usr_signed_${crypto.randomUUID()}`;

    const intent = await createIntent({
      mailboxId,
      userId,
      filename: "signed.txt",
      contentType: "text/plain",
      size: 42,
    });

    const url = new URL(intent.uploadUrl);

    const signedHeaders = url.searchParams
      .get("X-Amz-SignedHeaders")
      ?.split(";");

    expect(signedHeaders).toContain("content-type");
    // The declared size is signed, so R2 refuses an upload of any other length.
    expect(signedHeaders).toContain("content-length");
    expect(intent.headers).toEqual({ "content-type": "text/plain" });

    await discard({ mailboxId, userId, uploadIds: [intent.id] });
  });

  it("seals the declared bytes behind an immutable key before send", async () => {
    const mailboxId = `mbx_upload_${crypto.randomUUID()}`;
    const userId = `usr_upload_${crypto.randomUUID()}`;

    const correct = await createIntent({
      mailboxId,
      userId,
      filename: "correct.txt",
      contentType: "text/plain",
      size: 2,
    });

    const correctKey = composerUploadKey(mailboxId, userId, correct.id);

    const correctFinalKey = composerUploadFinalKey(
      mailboxId,
      userId,
      correct.id
    );

    await env.MAIL_STORAGE.put(correctKey, "ok");

    await expect(
      load({ mailboxId, userId, uploadId: correct.id })
    ).rejects.toThrow("Attachment upload was not found");
    await finalize({ mailboxId, userId, uploadId: correct.id });
    await expect(
      load({ mailboxId, userId, uploadId: correct.id })
    ).resolves.toMatchObject({
      filename: "correct.txt",
      r2Key: correctFinalKey,
      size: 2,
    });
    expect(await env.MAIL_STORAGE.head(correctKey)).toBeNull();
    expect(
      await env.MAIL_STORAGE.get(correctFinalKey).then((object) =>
        object?.text()
      )
    ).toBe("ok");

    // A presigned URL can still recreate staging until it expires, but send
    // reads only the immutable snapshot created by finalization.
    await env.MAIL_STORAGE.put(correctKey, "NO");
    expect(
      await env.MAIL_STORAGE.get(correctFinalKey).then((object) =>
        object?.text()
      )
    ).toBe("ok");

    const wrong = await createIntent({
      mailboxId,
      userId,
      filename: "wrong.txt",
      contentType: "text/plain",
      size: 3,
    });

    const wrongKey = composerUploadKey(mailboxId, userId, wrong.id);
    await env.MAIL_STORAGE.put(wrongKey, "no");
    await expect(
      finalize({ mailboxId, userId, uploadId: wrong.id })
    ).rejects.toThrow("Attachment upload is incomplete");
    expect(await env.MAIL_STORAGE.head(wrongKey)).toBeNull();
    expect(
      await env.MAIL_STORAGE.head(
        composerUploadMetaKey(mailboxId, userId, wrong.id)
      )
    ).not.toBeNull();
    expect(
      await env.MAIL_STORAGE.head(
        composerUploadFinalKey(mailboxId, userId, wrong.id)
      )
    ).toBeNull();

    await discard({ mailboxId, userId, uploadIds: [correct.id, wrong.id] });
  });

  it("returns the immutable upload before deferred staging cleanup finishes", async () => {
    const mailboxId = `mbx_deferred_${crypto.randomUUID()}`;
    const userId = `usr_deferred_${crypto.randomUUID()}`;

    const intent = await createIntent({
      mailboxId,
      userId,
      filename: "deferred.txt",
      contentType: "text/plain",
      size: 2,
    });

    const stagingKey = composerUploadKey(mailboxId, userId, intent.id);
    await env.MAIL_STORAGE.put(stagingKey, "ok");

    try {
      // Finalizes while the bucket's deletes wait, then lets them through.
      const { upload, deferred, loaded } = await hooks.call<{
        upload: Upload;
        deferred: number;
        loaded: Upload;
      }>("mailFlow.uploads.finalizeWithBlockedCleanup", {
        mailboxId,
        userId,
        uploadId: intent.id,
      });

      expect(deferred).toBe(1);
      expect(upload.r2Key).toBe(
        composerUploadFinalKey(mailboxId, userId, intent.id)
      );
      expect(loaded).toEqual(upload);
    } finally {
      await discard({ mailboxId, userId, uploadIds: [intent.id] });
    }
  });

  it("keeps the first immutable snapshot when finalizers race", async () => {
    const mailboxId = `mbx_race_${crypto.randomUUID()}`;
    const userId = `usr_race_${crypto.randomUUID()}`;

    const intent = await createIntent({
      mailboxId,
      userId,
      filename: "race.txt",
      contentType: "text/plain",
      size: 2,
    });

    const stagingKey = composerUploadKey(mailboxId, userId, intent.id);
    const immutableKey = composerUploadFinalKey(mailboxId, userId, intent.id);
    await env.MAIL_STORAGE.put(immutableKey, "v1");
    await env.MAIL_STORAGE.put(stagingKey, "v2");

    try {
      await finalize({ mailboxId, userId, uploadId: intent.id });

      expect(
        await env.MAIL_STORAGE.get(immutableKey).then((object) =>
          object?.text()
        )
      ).toBe("v1");
      await expect(
        load({ mailboxId, userId, uploadId: intent.id })
      ).resolves.toMatchObject({ r2Key: immutableKey, size: 2 });
    } finally {
      await discard({ mailboxId, userId, uploadIds: [intent.id] });
    }
  });

  it("returns the completed immutable upload to a finalizer that lost staging", async () => {
    const mailboxId = `mbx_finalize_race_${crypto.randomUUID()}`;
    const userId = `usr_finalize_race_${crypto.randomUUID()}`;

    const intent = await createIntent({
      mailboxId,
      userId,
      filename: "race.txt",
      contentType: "text/plain",
      size: 2,
    });

    const stagingKey = composerUploadKey(mailboxId, userId, intent.id);
    const metadataKey = composerUploadMetaKey(mailboxId, userId, intent.id);
    await env.MAIL_STORAGE.put(stagingKey, "ok");

    try {
      // The first finalizer holds after reading metadata until the second has
      // read it too; the second reads staging only once the first is done.
      const { first, second, loaded } = await hooks.call<{
        first: Upload;
        second:
          | { ok: true; value: Upload }
          | { ok: false; error: { name: string; message: string } };
        loaded: Upload;
      }>("mailFlow.uploads.finalizeRace", {
        mailboxId,
        userId,
        uploadId: intent.id,
        stagingKey,
        metadataKey,
      });

      expect(unwrap(second)).toEqual(first);
      expect(loaded).toEqual(first);
    } finally {
      await discard({ mailboxId, userId, uploadIds: [intent.id] });
    }
  });

  it("rejects mismatched fallback bodies before or during the R2 write", async () => {
    const mailboxId = `mbx_body_size_${crypto.randomUUID()}`;
    const userId = `usr_body_size_${crypto.randomUUID()}`;

    const intent = (filename: string) =>
      createIntent({
        mailboxId,
        userId,
        filename,
        contentType: "text/plain",
        size: 2,
      });

    const early = await intent("early.txt");
    const streamed = await intent("streamed.txt");
    const exact = await intent("exact.txt");

    const store = (
      uploadId: string,
      body: Uint8Array<ArrayBuffer>,
      options: { stream?: boolean; contentLength?: number }
    ) =>
      uploads({
        fn: "store",
        input: {
          mailboxId,
          userId,
          uploadId,
          contentType: "text/plain",
          contentLength: options.contentLength,
        },
        body,
        stream: options.stream,
      });

    try {
      await expect(
        store(early.id, new TextEncoder().encode("bad"), { contentLength: 3 })
      ).rejects.toThrow("Attachment size does not match");
      expect(
        await env.MAIL_STORAGE.head(
          composerUploadKey(mailboxId, userId, early.id)
        )
      ).toBeNull();

      await expect(
        store(streamed.id, new Uint8Array([1, 2, 3]), { stream: true })
      ).rejects.toThrow("Attachment size does not match");
      expect(
        await env.MAIL_STORAGE.head(
          composerUploadKey(mailboxId, userId, streamed.id)
        )
      ).toBeNull();

      await store(exact.id, new Uint8Array([1, 2]), { stream: true });
      expect(
        await env.MAIL_STORAGE.head(
          composerUploadKey(mailboxId, userId, exact.id)
        )
      ).toMatchObject({ size: 2 });
    } finally {
      await discard({
        mailboxId,
        userId,
        uploadIds: [early.id, streamed.id, exact.id],
      });
    }
  });

  it("rejects malformed upload metadata instead of trusting R2 JSON", async () => {
    const mailboxId = `mbx_meta_${crypto.randomUUID()}`;
    const userId = `usr_meta_${crypto.randomUUID()}`;

    const intent = await createIntent({
      mailboxId,
      userId,
      filename: "metadata.txt",
      contentType: "text/plain",
      size: 2,
    });

    await env.MAIL_STORAGE.put(
      composerUploadMetaKey(mailboxId, userId, intent.id),
      JSON.stringify({
        filename: 42,
        contentType: "text/plain",
        size: "2",
        uploadedBy: userId,
        mailboxId,
        finalizedAt: null,
      })
    );

    await expect(
      uploads({
        fn: "loadMetadata",
        input: { mailboxId, userId, uploadId: intent.id },
      })
    ).rejects.toThrow("Attachment upload was not found");
    await discard({ mailboxId, userId, uploadIds: [intent.id] });
  });
});
