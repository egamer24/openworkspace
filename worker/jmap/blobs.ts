import { uploadIdSchema } from "../mail/schemas";
import {
  loadComposerUpload,
  storeFinalizedComposerUpload,
  UploadValidationError,
} from "../mail/uploads";

/**
 * JMAP blob uploads (RFC 8620 section 6.1) belong to the account, not to one
 * mailbox, until an Email uses them. They are stored as finalized composer
 * uploads under a per-user "jmap" scope, so the composer-uploads/ lifecycle
 * rule expires unused blobs after seven days and the blob id is the upload id.
 */
const UPLOAD_SCOPE = "jmap";

export const MAX_UPLOAD_BYTES = 50_000_000;

export function storeUploadedBlob(env: Env, userId: string, contentType: string, body: ReadableStream | ArrayBuffer) {
  return storeFinalizedComposerUpload({
    env,
    mailboxId: UPLOAD_SCOPE,
    userId,
    filename: "blob",
    contentType,
    body,
  });
}

export async function loadUploadedBlob(env: Env, userId: string, blobId: unknown) {
  if (!uploadIdSchema.safeParse(blobId).success) return null;
  try {
    return await loadComposerUpload({ env, mailboxId: UPLOAD_SCOPE, userId, uploadId: blobId as string });
  } catch (error) {
    if (error instanceof UploadValidationError) return null;
    throw error;
  }
}
