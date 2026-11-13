import { describe, expect, it } from "bun:test";

import { signR2GetUrl } from "@open-workspace/email/worker/mail/r2-presigned-urls.ts";

describe("R2 presigned URLs", () => {
  it("signs a short-lived GET for exactly one private object", async () => {
    const beforeSigning = Date.now();

    const signed = await signR2GetUrl({
      // SAFETY: signing reads only env.MAIL_S3 (r2Signer → mailS3); no other binding is touched.
      env: {
        MAIL_S3: JSON.stringify({
          endpoint: "https://test-account.r2.cloudflarestorage.com",
          bucketName: "test-bucket",
          region: "auto",
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
        }),
      } as Env,
      r2Key: "mailboxes/mbx_test/messages/msg_test/attachments/att_test",
    });

    const afterSigning = Date.now();

    const url = new URL(signed.url);
    expect(url.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(
      "/test-bucket/mailboxes/mbx_test/messages/msg_test/attachments/att_test"
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/u);
    expect(signed.expiresAt).toBeGreaterThanOrEqual(beforeSigning + 900_000);
    expect(signed.expiresAt).toBeLessThanOrEqual(afterSigning + 900_000);
  });
});
