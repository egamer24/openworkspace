import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  composerUploadFinalKey,
  composerUploadKey,
  composerUploadMetaKey,
  createComposerUploadIntent,
  DirectUploadUnavailableError,
  discardComposerUploads,
  finalizeComposerUpload,
  loadComposerUpload,
  loadComposerUploadMetadata,
  storeComposerUploadContent,
} from "../worker/mail/uploads";

describe("composer upload finalization", () => {
  it("signs direct R2 uploads without requiring a buffered request body", async () => {
    const mailboxId = `mbx_signed_${crypto.randomUUID()}`;
    const userId = `usr_signed_${crypto.randomUUID()}`;
    const signedEnv = {
      ...env,
      R2_ACCESS_KEY_ID: "test-access-key",
      R2_SECRET_ACCESS_KEY: "test-secret-key",
      R2_ACCOUNT_ID: "test-account",
      R2_BUCKET_NAME: "test-bucket",
    };
    const intent = await createComposerUploadIntent({
      env: signedEnv,
      requestOrigin: "http://example.test",
      mailboxId,
      userId,
      filename: "signed.txt",
      contentType: "text/plain",
      size: 42,
      directOnly: true,
    });
    const url = new URL(intent.uploadUrl);

    const signedHeaders = url.searchParams
      .get("X-Amz-SignedHeaders")
      ?.split(";");
    expect(signedHeaders).toContain("content-type");
    // The client streams exactly the declared size; R2 rejects any other length.
    expect(signedHeaders).toContain("content-length");
    expect(intent.headers).toEqual({ "content-type": "text/plain" });

    await discardComposerUploads({
      env,
      mailboxId,
      userId,
      uploadIds: [intent.id],
    });
  });

  it("does not expose the internal upload fallback to MCP clients", async () => {
    const mailboxId = `mbx_direct_${crypto.randomUUID()}`;
    const userId = `usr_direct_${crypto.randomUUID()}`;

    await expect(createComposerUploadIntent({
      env,
      requestOrigin: "https://account-api.internal",
      mailboxId,
      userId,
      filename: "direct.txt",
      contentType: "text/plain",
      size: 2,
      directOnly: true,
    })).rejects.toBeInstanceOf(DirectUploadUnavailableError);

    const stored = await env.MAIL_STORAGE.list({
      prefix: `composer-uploads/${mailboxId}/${userId}/`,
    });
    expect(stored.objects).toHaveLength(0);
  });

  it("seals the declared bytes behind an immutable key before send", async () => {
    const mailboxId = `mbx_upload_${crypto.randomUUID()}`;
    const userId = `usr_upload_${crypto.randomUUID()}`;
    const correct = await createComposerUploadIntent({
      env,
      requestOrigin: "http://example.test",
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
      correct.id,
    );
    await env.MAIL_STORAGE.put(correctKey, "ok");

    await expect(loadComposerUpload({
      env,
      mailboxId,
      userId,
      uploadId: correct.id,
    })).rejects.toThrow("Attachment upload was not found");
    await finalizeComposerUpload({
      env,
      mailboxId,
      userId,
      uploadId: correct.id,
    });
    await expect(loadComposerUpload({
      env,
      mailboxId,
      userId,
      uploadId: correct.id,
    })).resolves.toMatchObject({
      filename: "correct.txt",
      r2Key: correctFinalKey,
      size: 2,
    });
    expect(await env.MAIL_STORAGE.head(correctKey)).toBeNull();
    expect(await env.MAIL_STORAGE.get(correctFinalKey).then((object) =>
      object?.text()
    )).toBe("ok");

    // A presigned URL can still recreate staging until it expires, but send
    // reads only the immutable snapshot created by finalization.
    await env.MAIL_STORAGE.put(correctKey, "NO");
    expect(await env.MAIL_STORAGE.get(correctFinalKey).then((object) =>
      object?.text()
    )).toBe("ok");

    const wrong = await createComposerUploadIntent({
      env,
      requestOrigin: "http://example.test",
      mailboxId,
      userId,
      filename: "wrong.txt",
      contentType: "text/plain",
      size: 3,
    });
    const wrongKey = composerUploadKey(mailboxId, userId, wrong.id);
    await env.MAIL_STORAGE.put(wrongKey, "no");
    await expect(finalizeComposerUpload({
      env,
      mailboxId,
      userId,
      uploadId: wrong.id,
    })).rejects.toThrow("Attachment upload is incomplete");
    expect(await env.MAIL_STORAGE.head(wrongKey)).toBeNull();
    expect(
      await env.MAIL_STORAGE.head(
        composerUploadMetaKey(mailboxId, userId, wrong.id),
      ),
    ).not.toBeNull();
    expect(
      await env.MAIL_STORAGE.head(
        composerUploadFinalKey(mailboxId, userId, wrong.id),
      ),
    ).toBeNull();

    await discardComposerUploads({
      env,
      mailboxId,
      userId,
      uploadIds: [correct.id, wrong.id],
    });
  });

  it("returns the immutable upload before deferred staging cleanup finishes", async () => {
    const mailboxId = `mbx_deferred_${crypto.randomUUID()}`;
    const userId = `usr_deferred_${crypto.randomUUID()}`;
    const intent = await createComposerUploadIntent({
      env,
      requestOrigin: "http://example.test",
      mailboxId,
      userId,
      filename: "deferred.txt",
      contentType: "text/plain",
      size: 2,
    });
    const stagingKey = composerUploadKey(mailboxId, userId, intent.id);
    await env.MAIL_STORAGE.put(stagingKey, "ok");

    let releaseDelete = () => {};
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const blockingStorage = new Proxy(env.MAIL_STORAGE, {
      get(target, property) {
        if (property === "delete") {
          return async (...keys: Parameters<R2Bucket["delete"]>) => {
            await deleteGate;
            return target.delete(...keys);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const deferred: Promise<unknown>[] = [];

    try {
      const upload = await finalizeComposerUpload({
        env: { ...env, MAIL_STORAGE: blockingStorage },
        mailboxId,
        userId,
        uploadId: intent.id,
        defer: (task) => deferred.push(task),
      });

      expect(deferred).toHaveLength(1);
      expect(upload.r2Key).toBe(
        composerUploadFinalKey(mailboxId, userId, intent.id),
      );
      await expect(loadComposerUpload({
        env,
        mailboxId,
        userId,
        uploadId: intent.id,
      })).resolves.toEqual(upload);
    } finally {
      releaseDelete();
      await Promise.all(deferred);
      await discardComposerUploads({
        env,
        mailboxId,
        userId,
        uploadIds: [intent.id],
      });
    }
  });

  it("keeps the first immutable snapshot when finalizers race", async () => {
    const mailboxId = `mbx_race_${crypto.randomUUID()}`;
    const userId = `usr_race_${crypto.randomUUID()}`;
    const intent = await createComposerUploadIntent({
      env,
      requestOrigin: "http://example.test",
      mailboxId,
      userId,
      filename: "race.txt",
      contentType: "text/plain",
      size: 2,
    });
    const stagingKey = composerUploadKey(mailboxId, userId, intent.id);
    const immutableKey = composerUploadFinalKey(
      mailboxId,
      userId,
      intent.id,
    );
    await env.MAIL_STORAGE.put(immutableKey, "v1");
    await env.MAIL_STORAGE.put(stagingKey, "v2");

    try {
      await finalizeComposerUpload({
        env,
        mailboxId,
        userId,
        uploadId: intent.id,
      });

      expect(
        await env.MAIL_STORAGE.get(immutableKey).then((object) => object?.text()),
      ).toBe("v1");
      await expect(loadComposerUpload({
        env,
        mailboxId,
        userId,
        uploadId: intent.id,
      })).resolves.toMatchObject({ r2Key: immutableKey, size: 2 });
    } finally {
      await discardComposerUploads({
        env,
        mailboxId,
        userId,
        uploadIds: [intent.id],
      });
    }
  });

  it("returns the completed immutable upload to a finalizer that lost staging", async () => {
    const mailboxId = `mbx_finalize_race_${crypto.randomUUID()}`;
    const userId = `usr_finalize_race_${crypto.randomUUID()}`;
    const intent = await createComposerUploadIntent({
      env,
      requestOrigin: "http://example.test",
      mailboxId,
      userId,
      filename: "race.txt",
      contentType: "text/plain",
      size: 2,
    });
    const stagingKey = composerUploadKey(mailboxId, userId, intent.id);
    const metadataKey = composerUploadMetaKey(mailboxId, userId, intent.id);
    await env.MAIL_STORAGE.put(stagingKey, "ok");

    let releaseSecondMetadataRead = () => {};
    const secondMetadataRead = new Promise<void>((resolve) => {
      releaseSecondMetadataRead = resolve;
    });
    let releaseSecondStagingRead = () => {};
    const secondStagingGate = new Promise<void>((resolve) => {
      releaseSecondStagingRead = resolve;
    });
    const firstGet = async (key: string, options?: R2GetOptions) => {
      const object = await env.MAIL_STORAGE.get(key, options);
      if (key === metadataKey) await secondMetadataRead;
      return object;
    };
    const secondGet = async (key: string, options?: R2GetOptions) => {
      if (key === stagingKey) await secondStagingGate;
      const object = await env.MAIL_STORAGE.get(key, options);
      if (key === metadataKey) releaseSecondMetadataRead();
      return object;
    };
    const firstStorage = new Proxy(env.MAIL_STORAGE, {
      get(target, property) {
        if (property === "get") return firstGet;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const secondStorage = new Proxy(env.MAIL_STORAGE, {
      get(target, property) {
        if (property === "get") return secondGet;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    try {
      const first = finalizeComposerUpload({
        env: { ...env, MAIL_STORAGE: firstStorage },
        mailboxId,
        userId,
        uploadId: intent.id,
      });
      const second = finalizeComposerUpload({
        env: { ...env, MAIL_STORAGE: secondStorage },
        mailboxId,
        userId,
        uploadId: intent.id,
      });
      const firstResult = await first;
      releaseSecondStagingRead();

      await expect(second).resolves.toEqual(firstResult);
      await expect(loadComposerUpload({
        env,
        mailboxId,
        userId,
        uploadId: intent.id,
      })).resolves.toEqual(firstResult);
    } finally {
      releaseSecondMetadataRead();
      releaseSecondStagingRead();
      await discardComposerUploads({
        env,
        mailboxId,
        userId,
        uploadIds: [intent.id],
      });
    }
  });

  it("rejects mismatched fallback bodies before or during the R2 write", async () => {
    const mailboxId = `mbx_body_size_${crypto.randomUUID()}`;
    const userId = `usr_body_size_${crypto.randomUUID()}`;
    const early = await createComposerUploadIntent({
      env,
      requestOrigin: "http://example.test",
      mailboxId,
      userId,
      filename: "early.txt",
      contentType: "text/plain",
      size: 2,
    });
    const streamed = await createComposerUploadIntent({
      env,
      requestOrigin: "http://example.test",
      mailboxId,
      userId,
      filename: "streamed.txt",
      contentType: "text/plain",
      size: 2,
    });
    const exact = await createComposerUploadIntent({
      env,
      requestOrigin: "http://example.test",
      mailboxId,
      userId,
      filename: "exact.txt",
      contentType: "text/plain",
      size: 2,
    });

    try {
      await expect(storeComposerUploadContent({
        env,
        mailboxId,
        userId,
        uploadId: early.id,
        body: new Blob(["bad"], { type: "text/plain" }),
        contentType: "text/plain",
        contentLength: 3,
      })).rejects.toThrow("Attachment size does not match");
      expect(
        await env.MAIL_STORAGE.head(
          composerUploadKey(mailboxId, userId, early.id),
        ),
      ).toBeNull();

      const oversized = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      await expect(storeComposerUploadContent({
        env,
        mailboxId,
        userId,
        uploadId: streamed.id,
        body: oversized,
        contentType: "text/plain",
      })).rejects.toThrow("Attachment size does not match");
      expect(
        await env.MAIL_STORAGE.head(
          composerUploadKey(mailboxId, userId, streamed.id),
        ),
      ).toBeNull();

      await storeComposerUploadContent({
        env,
        mailboxId,
        userId,
        uploadId: exact.id,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.close();
          },
        }),
        contentType: "text/plain",
      });
      expect(
        await env.MAIL_STORAGE.head(
          composerUploadKey(mailboxId, userId, exact.id),
        ),
      ).toMatchObject({ size: 2 });
    } finally {
      await discardComposerUploads({
        env,
        mailboxId,
        userId,
        uploadIds: [early.id, streamed.id, exact.id],
      });
    }
  });

  it("rejects malformed upload metadata instead of trusting R2 JSON", async () => {
    const mailboxId = `mbx_meta_${crypto.randomUUID()}`;
    const userId = `usr_meta_${crypto.randomUUID()}`;
    const intent = await createComposerUploadIntent({
      env,
      requestOrigin: "http://example.test",
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
      }),
    );

    await expect(loadComposerUploadMetadata({
      env,
      mailboxId,
      userId,
      uploadId: intent.id,
    })).rejects.toThrow("Attachment upload was not found");
    await discardComposerUploads({
      env,
      mailboxId,
      userId,
      uploadIds: [intent.id],
    });
  });
});
