import { describe, expect, it } from "vitest";
import { signR2GetUrl, signR2PutUrl } from "../worker/mail/r2-presigned-urls";

describe("R2 presigned URLs", () => {
  it("signs a short-lived GET for exactly one private object", async () => {
    const beforeSigning = Date.now();
    const signed = await signR2GetUrl({
      env: {
        R2_ACCESS_KEY_ID: "test-access-key",
        R2_SECRET_ACCESS_KEY: "test-secret-key",
        R2_ACCOUNT_ID: "test-account",
        R2_BUCKET_NAME: "test-bucket",
      } as unknown as Env,
      r2Key: "mailboxes/mbx_test/messages/msg_test/attachments/att_test",
    });
    const afterSigning = Date.now();

    expect(signed).not.toBeNull();
    const url = new URL(signed!.url);
    expect(url.origin).toBe(
      "https://test-account.r2.cloudflarestorage.com",
    );
    expect(url.pathname).toBe(
      "/test-bucket/mailboxes/mbx_test/messages/msg_test/attachments/att_test",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/u);
    expect(signed!.expiresAt).toBeGreaterThanOrEqual(beforeSigning + 900_000);
    expect(signed!.expiresAt).toBeLessThanOrEqual(afterSigning + 900_000);
  });

  it("binds an upload URL to the declared size", async () => {
    const signed = await signR2PutUrl({
      env: {
        R2_ACCESS_KEY_ID: "test-access-key",
        R2_SECRET_ACCESS_KEY: "test-secret-key",
        R2_ACCOUNT_ID: "test-account",
      } as unknown as Env,
      r2Key: "drive/staging/item",
      contentType: "image/png",
      contentLength: 1234,
    });
    expect(new URL(signed!).searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  });

  it("does not create a link without R2 S3 credentials", async () => {
    await expect(signR2GetUrl({
      env: {} as Env,
      r2Key: "mailboxes/mbx_test/file",
    })).resolves.toBeNull();
  });
});
