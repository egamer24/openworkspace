import { z } from "zod";
import { MAX_COMPOSER_ATTACHMENT_BYTES } from "../../shared/mail";
import type { AppEnv } from "../env";
import { createId } from "../lib/ids";
import { signR2PutUrl } from "./r2-presigned-urls";

type Bindings = AppEnv["Bindings"];

export type UploadedAttachment = {
  id: string;
  r2Key: string;
  filename: string;
  contentType: string;
  size: number;
};

export type ComposerUploadIntent = {
  id: string;
  uploadUrl: string;
  headers: Record<string, string>;
  filename: string;
  contentType: string;
  size: number;
};

type UploadMeta = {
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  mailboxId: string;
  finalizedAt: number | null;
};

const uploadMetaSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  size: z.number().int().positive().max(MAX_COMPOSER_ATTACHMENT_BYTES),
  uploadedBy: z.string().min(1),
  mailboxId: z.string().min(1),
  finalizedAt: z.number().int().nonnegative().nullable(),
}).strict();

function composerUploadPrefix(
  mailboxId: string,
  userId: string,
  uploadId: string,
) {
  return `composer-uploads/${mailboxId}/${userId}/${uploadId}`;
}

export function composerUploadKey(
  mailboxId: string,
  userId: string,
  uploadId: string,
) {
  return `${composerUploadPrefix(mailboxId, userId, uploadId)}/staging`;
}

export function composerUploadFinalKey(
  mailboxId: string,
  userId: string,
  uploadId: string,
) {
  return `${composerUploadPrefix(mailboxId, userId, uploadId)}/immutable`;
}

export function composerUploadMetaKey(
  mailboxId: string,
  userId: string,
  uploadId: string,
) {
  return `${composerUploadPrefix(mailboxId, userId, uploadId)}/metadata.json`;
}

function composerUploadKeys(
  mailboxId: string,
  userId: string,
  uploadId: string,
) {
  return {
    staging: composerUploadKey(mailboxId, userId, uploadId),
    immutable: composerUploadFinalKey(mailboxId, userId, uploadId),
    metadata: composerUploadMetaKey(mailboxId, userId, uploadId),
  };
}

async function putUploadMeta(input: {
  env: Bindings;
  metadataKey: string;
  meta: UploadMeta;
}) {
  await input.env.MAIL_STORAGE.put(
    input.metadataKey,
    JSON.stringify(input.meta),
    { httpMetadata: { contentType: "application/json" } },
  );
}

async function readUploadMeta(env: Bindings, metadataKey: string) {
  const object = await env.MAIL_STORAGE.get(metadataKey);
  if (!object) return null;
  try {
    const parsed = uploadMetaSchema.safeParse(JSON.parse(await object.text()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function createComposerUploadIntent(input: {
  env: Bindings;
  requestOrigin: string;
  mailboxId: string;
  userId: string;
  filename: string;
  contentType: string;
  size: number;
  directOnly?: boolean;
}): Promise<ComposerUploadIntent> {
  if (input.size <= 0) {
    throw new UploadValidationError("Attachment file is empty");
  }
  if (input.size > MAX_COMPOSER_ATTACHMENT_BYTES) {
    throw new UploadValidationError(
      `Attachments are limited to ${Math.floor(MAX_COMPOSER_ATTACHMENT_BYTES / 1_000_000)} MB per message`,
    );
  }

  const id = createId("upl");
  const keys = composerUploadKeys(input.mailboxId, input.userId, id);
  const filename = input.filename.trim().slice(0, 255) || "attachment";
  const contentType =
    input.contentType.trim().slice(0, 255) || "application/octet-stream";

  await putUploadMeta({
    env: input.env,
    metadataKey: keys.metadata,
    meta: {
      filename,
      contentType,
      size: input.size,
      uploadedBy: input.userId,
      mailboxId: input.mailboxId,
      finalizedAt: null,
    },
  });

  const headers = { "content-type": contentType };
  const presignedUrl = await signR2PutUrl({
    env: input.env,
    r2Key: keys.staging,
    contentType,
  });
  if (presignedUrl) {
    return {
      id,
      uploadUrl: presignedUrl,
      headers,
      filename,
      contentType,
      size: input.size,
    };
  }

  if (input.directOnly) {
    await input.env.MAIL_STORAGE.delete(keys.metadata);
    throw new DirectUploadUnavailableError(
      "Direct R2 attachment uploads are not configured",
    );
  }

  // Local / Deploy without R2 S3 API tokens: same client flow, Worker receives PUT.
  const fallback = new URL("/api/mail/uploads/content", input.requestOrigin);
  fallback.searchParams.set("mailboxId", input.mailboxId);
  fallback.searchParams.set("uploadId", id);
  return {
    id,
    uploadUrl: fallback.toString(),
    headers,
    filename,
    contentType,
    size: input.size,
  };
}

export async function storeComposerUploadContent(input: {
  env: Bindings;
  mailboxId: string;
  userId: string;
  uploadId: string;
  body: ReadableStream<Uint8Array> | ArrayBuffer | Blob | null;
  contentType: string | undefined;
  contentLength?: number;
}) {
  if (!input.body) {
    throw new UploadValidationError("Attachment body is required");
  }
  const keys = composerUploadKeys(
    input.mailboxId,
    input.userId,
    input.uploadId,
  );
  const meta = assertUploadOwner(
    await readUploadMeta(input.env, keys.metadata),
    input.userId,
    input.mailboxId,
  );
  if (meta.finalizedAt !== null) {
    throw new UploadValidationError("Attachment upload is already complete");
  }
  const contentType = (input.contentType || meta.contentType)
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (contentType !== meta.contentType.trim().toLowerCase()) {
    throw new UploadValidationError("Attachment content type does not match");
  }
  if (
    input.contentLength !== undefined
    && (
      !Number.isSafeInteger(input.contentLength)
      || input.contentLength !== meta.size
    )
  ) {
    throw new UploadValidationError("Attachment size does not match");
  }

  const sizeState = { mismatch: false };
  const uploadBody = uploadBodyWithExactSize(input.body, meta.size, sizeState);
  const write = input.env.MAIL_STORAGE.put(keys.staging, uploadBody.body, {
    httpMetadata: { contentType: meta.contentType },
  });
  const results = await Promise.allSettled([
    write,
    ...(uploadBody.completion ? [uploadBody.completion] : []),
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure || sizeState.mismatch) {
    await deleteStagingObject(input.env, keys.staging);
    if (sizeState.mismatch) {
      throw new UploadValidationError("Attachment size does not match");
    }
    throw failure!.reason;
  }
  const stored = await input.env.MAIL_STORAGE.head(keys.staging);
  if (!stored || stored.size !== meta.size) {
    await deleteStagingObject(input.env, keys.staging);
    throw new UploadValidationError("Attachment size does not match");
  }
}

export function uploadBodyWithExactSize(
  body: ReadableStream<Uint8Array> | ArrayBuffer | Blob,
  expectedSize: number,
  state: { mismatch: boolean },
) {
  if (body instanceof ArrayBuffer) {
    if (body.byteLength !== expectedSize) {
      throw new UploadValidationError("Attachment size does not match");
    }
    return { body, completion: null };
  }
  if (body instanceof Blob) {
    if (body.size !== expectedSize) {
      throw new UploadValidationError("Attachment size does not match");
    }
    return { body, completion: null };
  }

  const reader = body.getReader();
  let received = 0;
  const bounded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (received !== expectedSize) state.mismatch = true;
        controller.close();
        return;
      }
      const remaining = expectedSize - received;
      if (chunk.value.byteLength > remaining) {
        state.mismatch = true;
        if (remaining > 0) {
          controller.enqueue(chunk.value.subarray(0, remaining));
        }
        await reader.cancel();
        controller.close();
        return;
      }
      received += chunk.value.byteLength;
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const fixedLength = new FixedLengthStream(expectedSize);
  return {
    body: fixedLength.readable,
    completion: bounded.pipeTo(fixedLength.writable),
  };
}

function assertUploadOwner(
  meta: UploadMeta | null,
  userId: string,
  mailboxId: string,
) {
  if (
    !meta
    || meta.uploadedBy !== userId
    || meta.mailboxId !== mailboxId
  ) {
    throw new UploadValidationError("Attachment upload was not found");
  }
  return meta;
}

export async function loadComposerUploadMetadata(input: {
  env: Bindings;
  mailboxId: string;
  userId: string;
  uploadId: string;
}): Promise<UploadedAttachment> {
  const keys = composerUploadKeys(
    input.mailboxId,
    input.userId,
    input.uploadId,
  );
  const meta = assertUploadOwner(
    await readUploadMeta(input.env, keys.metadata),
    input.userId,
    input.mailboxId,
  );
  return {
    id: input.uploadId,
    r2Key: meta.finalizedAt === null ? keys.staging : keys.immutable,
    filename: meta.filename,
    contentType: meta.contentType,
    size: meta.size,
  };
}

export async function finalizeComposerUpload(input: {
  env: Bindings;
  mailboxId: string;
  userId: string;
  uploadId: string;
  defer?: (task: Promise<unknown>) => void;
}): Promise<UploadedAttachment> {
  const keys = composerUploadKeys(
    input.mailboxId,
    input.userId,
    input.uploadId,
  );
  const meta = assertUploadOwner(
    await readUploadMeta(input.env, keys.metadata),
    input.userId,
    input.mailboxId,
  );
  if (meta.finalizedAt !== null) {
    const upload = await loadComposerUpload(input);
    await cleanupStagingAfterFinalization(input, keys.staging);
    return upload;
  }

  const staging = await input.env.MAIL_STORAGE.get(keys.staging);
  if (
    !staging
    || staging.size <= 0
    || staging.size !== meta.size
    || staging.size > MAX_COMPOSER_ATTACHMENT_BYTES
  ) {
    const immutable = await input.env.MAIL_STORAGE.head(keys.immutable);
    if (immutable?.size === meta.size) {
      return completeComposerUploadFinalization(input, keys, meta);
    }
    // Do not delete metadata or the immutable key here: another finalizer may
    // already hold the valid staging body and be about to seal it.
    await deleteStagingObject(input.env, keys.staging);
    throw new UploadValidationError("Attachment upload is incomplete");
  }

  // The client never receives this key. A still-valid presigned staging URL
  // can be replayed, but it cannot mutate the immutable bytes used for send.
  const created = await input.env.MAIL_STORAGE.put(keys.immutable, staging.body, {
    httpMetadata: { contentType: meta.contentType },
    onlyIf: new Headers({ "if-none-match": "*" }),
  });
  // A concurrent finalizer may win the conditional write. In that case its
  // first sealed snapshot remains authoritative for this upload id.
  const immutable = created
    ?? await input.env.MAIL_STORAGE.head(keys.immutable);
  if (!immutable || immutable.size !== meta.size) {
    await deleteStagingObject(input.env, keys.staging);
    throw new UploadValidationError("Attachment upload is incomplete");
  }
  return completeComposerUploadFinalization(input, keys, meta);
}

async function completeComposerUploadFinalization(
  input: {
    env: Bindings;
    mailboxId: string;
    userId: string;
    uploadId: string;
    defer?: (task: Promise<unknown>) => void;
  },
  keys: ReturnType<typeof composerUploadKeys>,
  meta: UploadMeta,
): Promise<UploadedAttachment> {
  await putUploadMeta({
    env: input.env,
    metadataKey: keys.metadata,
    meta: {
      ...meta,
      finalizedAt: Date.now(),
    },
  });
  await cleanupStagingAfterFinalization(input, keys.staging);
  return {
    id: input.uploadId,
    r2Key: keys.immutable,
    filename: meta.filename,
    contentType: meta.contentType,
    size: meta.size,
  };
}

function cleanupStagingAfterFinalization(
  input: {
    env: Bindings;
    defer?: (task: Promise<unknown>) => void;
  },
  key: string,
) {
  const cleanup = deleteStagingObject(input.env, key);
  if (input.defer) input.defer(cleanup);
  else return cleanup;
}

async function deleteStagingObject(env: Bindings, key: string) {
  try {
    await env.MAIL_STORAGE.delete(key);
  } catch (error) {
    // composer-uploads/ expires automatically, so cleanup must not fail upload.
    console.error("Could not remove composer upload staging", error);
  }
}

export async function loadComposerUpload(input: {
  env: Bindings;
  mailboxId: string;
  userId: string;
  uploadId: string;
}): Promise<UploadedAttachment> {
  const keys = composerUploadKeys(
    input.mailboxId,
    input.userId,
    input.uploadId,
  );
  const [object, meta] = await Promise.all([
    input.env.MAIL_STORAGE.head(keys.immutable),
    readUploadMeta(input.env, keys.metadata),
  ]);
  if (!object || !meta || typeof meta.finalizedAt !== "number") {
    throw new UploadValidationError("Attachment upload was not found");
  }
  if (meta.uploadedBy !== input.userId || meta.mailboxId !== input.mailboxId) {
    throw new UploadValidationError("Attachment upload was not found");
  }
  if (object.size <= 0 || object.size !== meta.size) {
    throw new UploadValidationError("Attachment upload is incomplete");
  }
  if (object.size > MAX_COMPOSER_ATTACHMENT_BYTES) {
    throw new UploadValidationError("Attachment upload is invalid");
  }
  return {
    id: input.uploadId,
    r2Key: keys.immutable,
    filename: meta.filename,
    contentType: meta.contentType,
    size: object.size,
  };
}

export async function copyStoredAttachmentToMessage(input: {
  env: Bindings;
  sourceKey: string;
  destinationKey: string;
  contentType: string;
}) {
  const source = await input.env.MAIL_STORAGE.get(input.sourceKey);
  if (!source?.body) {
    throw new UploadValidationError("Attachment was not found");
  }
  await input.env.MAIL_STORAGE.put(input.destinationKey, source.body, {
    httpMetadata: { contentType: input.contentType },
  });
}

async function deleteComposerUploadObjects(
  env: Bindings,
  keys: ReturnType<typeof composerUploadKeys>,
) {
  try {
    await env.MAIL_STORAGE.delete([
      keys.staging,
      keys.immutable,
      keys.metadata,
    ]);
  } catch (error) {
    console.error("Could not remove composer upload objects", error);
  }
}

export async function discardComposerUploads(input: {
  env: Bindings;
  mailboxId: string;
  userId: string;
  uploadIds: string[];
}) {
  await Promise.all(
    input.uploadIds.map((uploadId) =>
      deleteComposerUploadObjects(
        input.env,
        composerUploadKeys(input.mailboxId, input.userId, uploadId),
      )
    ),
  );
}

export class UploadValidationError extends Error {}
export class DirectUploadUnavailableError extends Error {}
