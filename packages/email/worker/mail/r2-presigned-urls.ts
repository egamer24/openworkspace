import type { AppEnv } from "@open-workspace/core/module";
import { AwsClient } from "aws4fetch";
import { z } from "zod";

type Bindings = AppEnv["Bindings"];

const PRESIGN_TTL_SECONDS = 15 * 60;

const MailS3 = z.object({
  endpoint: z.string(),
  bucketName: z.string(),
  region: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
});

/** The mail bucket's S3 endpoint, name and credentials (`MAIL_S3`, from Alchemy's `S3Credentials`). */
export function mailS3(env: Pick<Bindings, "MAIL_S3">) {
  return MailS3.parse(JSON.parse(env.MAIL_S3));
}

function r2Signer(env: Bindings, r2Key: string) {
  const s3 = mailS3(env);

  const url = new URL(
    `${s3.endpoint}/${encodeURIComponent(s3.bucketName)}/${r2Key}`
  );

  url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));

  return {
    client: new AwsClient({
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      service: "s3",
      region: s3.region,
    }),
    url,
  };
}

export async function signR2PutUrl(input: {
  env: Bindings;
  r2Key: string;
  contentType: string;
}) {
  const signer = r2Signer(input.env, input.r2Key);

  const signed = await signer.client.sign(signer.url, {
    method: "PUT",
    headers: {
      "content-type": input.contentType,
    },
    aws: {
      allHeaders: true,
      signQuery: true,
    },
  });

  return signed.url;
}

export async function signR2GetUrl(input: { env: Bindings; r2Key: string }) {
  const signer = r2Signer(input.env, input.r2Key);

  const signed = await signer.client.sign(signer.url, {
    method: "GET",
    aws: { signQuery: true },
  });

  return {
    url: signed.url,
    expiresAt: Date.now() + PRESIGN_TTL_SECONDS * 1000,
  };
}
