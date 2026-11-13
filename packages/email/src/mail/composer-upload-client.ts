import { ApiError, responseJson } from "@open-workspace/core/ui";

import { isComposerInlineImageContentType } from "../../shared/mail";
import { mailApi } from "../lib/mail-api";

export function uploadContentType(file: File) {
  return file.type || "application/octet-stream";
}

export function isInlineComposerImage(file: File) {
  return isComposerInlineImageContentType(uploadContentType(file));
}

export async function createComposerUploadIntent(
  mailboxId: string,
  file: { filename: string; contentType: string; size: number }
) {
  return responseJson(
    await mailApi.api.mail.uploads.$post({
      query: { mailboxId },
      json: file,
    })
  );
}

export async function discardComposerUpload(
  mailboxId: string,
  uploadId: string
) {
  await responseJson(
    await mailApi.api.mail.uploads[":id"].$delete(
      {
        param: { id: uploadId },
        query: { mailboxId },
      },
      { init: { keepalive: true } }
    )
  );
}

export async function completeComposerUpload(
  mailboxId: string,
  uploadId: string
) {
  try {
    return await requestComposerUploadCompletion(mailboxId, uploadId);
  } catch (error) {
    // Finalization is idempotent. Retry only failures where the server may
    // have completed the first request but its response was lost.
    if (error instanceof ApiError && error.status < 500) throw error;

    return requestComposerUploadCompletion(mailboxId, uploadId);
  }
}

async function requestComposerUploadCompletion(
  mailboxId: string,
  uploadId: string
) {
  return responseJson(
    await mailApi.api.mail.uploads[":id"].complete.$post({
      param: { id: uploadId },
      query: { mailboxId },
    })
  );
}

export function uploadComposerFile(
  uploadUrl: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (progress: number) => void,
  onRequest: (request: XMLHttpRequest) => void
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    onRequest(request);
    request.open("PUT", uploadUrl);

    for (const [name, value] of Object.entries(headers)) {
      request.setRequestHeader(name, value);
    }

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(1, event.loaded / event.total));
      }
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(`Attachment upload failed (${request.status})`));
      }
    });
    request.addEventListener("error", () => {
      reject(new Error("Attachment upload failed"));
    });
    request.addEventListener("abort", () => {
      reject(new DOMException("Attachment upload was cancelled", "AbortError"));
    });
    request.send(file);
  });
}
