import {
  MAX_OFFICE_PREVIEW_BYTES,
  officePreviewKey,
} from "../../shared/office-preview";

export type OfficeConversionResult = "ready" | "failed";

export async function convertOfficeDocument(
  bucket: R2Bucket,
  send: (request: Request) => Promise<Response>,
  sourceKey: string,
  extension: string
): Promise<OfficeConversionResult> {
  const source = await bucket.get(sourceKey);

  if (!source) return "failed";

  // FormData buffers the upload in the Worker; cap it before reading the body.
  if (source.size > MAX_OFFICE_PREVIEW_BYTES) {
    await source.body.cancel();

    return "failed";
  }

  const form = new FormData();
  form.append(
    "files",
    new Blob([await source.arrayBuffer()]),
    `document.${extension}`
  );

  const response = await send(
    new Request("http://container/forms/libreoffice/convert", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
  );

  if (!response.ok) {
    await response.body?.cancel();

    if ([400, 403, 415, 422].includes(response.status)) return "failed";
    throw new Error(`Office conversion failed with status ${response.status}`);
  }

  if (
    !response.body ||
    response.headers.get("content-type")?.split(";", 1)[0] !== "application/pdf"
  ) {
    await response.body?.cancel();
    throw new Error("Office converter did not return a PDF");
  }

  await bucket.put(officePreviewKey(sourceKey), response.body, {
    httpMetadata: { contentType: "application/pdf" },
  });

  return "ready";
}
