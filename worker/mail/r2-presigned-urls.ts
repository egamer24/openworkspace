import { AwsClient } from "aws4fetch";
import type { AppEnv } from "../env";

type Bindings = AppEnv["Bindings"];

const PRESIGN_TTL_SECONDS = 15 * 60;

function r2S3Credentials(env: Bindings) {
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucketName = env.R2_BUCKET_NAME?.trim() || "openworkspace";
  if (!accessKeyId || !secretAccessKey || !accountId) return null;
  return { accessKeyId, secretAccessKey, accountId, bucketName };
}

function r2Signer(env: Bindings, r2Key: string) {
  const credentials = r2S3Credentials(env);
  if (!credentials) return null;
  return {
    client: new AwsClient({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      service: "s3",
      region: "auto",
    }),
    url: new URL(
      `https://${credentials.accountId}.r2.cloudflarestorage.com/${credentials.bucketName}/${r2Key}`,
    ),
  };
}

export async function signR2PutUrl(input: {
  env: Bindings;
  r2Key: string;
  contentType: string;
  /** Signed, so the URL stores exactly the declared size (quota and caps use it). */
  contentLength: number;
}) {
  const signer = r2Signer(input.env, input.r2Key);
  if (!signer) return null;
  signer.url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));
  const signed = await signer.client.sign(signer.url, {
    method: "PUT",
    headers: {
      "content-length": String(input.contentLength),
      "content-type": input.contentType,
    },
    aws: {
      allHeaders: true,
      signQuery: true,
    },
  });
  return signed.url;
}

export async function signR2GetUrl(input: {
  env: Bindings;
  r2Key: string;
}) {
  const signer = r2Signer(input.env, input.r2Key);
  if (!signer) return null;
  signer.url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));
  const signed = await signer.client.sign(signer.url, {
    method: "GET",
    aws: { signQuery: true },
  });
  return {
    url: signed.url,
    expiresAt: Date.now() + PRESIGN_TTL_SECONDS * 1_000,
  };
}
