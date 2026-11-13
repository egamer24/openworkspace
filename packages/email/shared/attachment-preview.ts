import { isComposerInlineImageContentType } from "./mail";
import { officePreviewExtension } from "./office-preview";
import type { PdfPreviewStatus } from "./office-preview";

const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/xml",
  "text/yaml",
  "application/json",
  "application/xml",
  "application/yaml",
]);

const EXTENSION_TYPES = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["txt", "text/plain"],
  ["log", "text/plain"],
  ["md", "text/markdown"],
  ["csv", "text/csv"],
  ["tsv", "text/tab-separated-values"],
  ["json", "application/json"],
  ["xml", "application/xml"],
  ["yaml", "application/yaml"],
  ["yml", "application/yaml"],
]);

export function attachmentPreview(file: {
  filename: string;
  contentType: string;
  pdfPreviewStatus?: PdfPreviewStatus | null;
}): {
  kind: "pdf" | "image" | "text";
  contentType: string;
} | null {
  if (file.pdfPreviewStatus && officePreviewExtension(file.filename)) {
    return { kind: "pdf", contentType: "application/pdf" };
  }

  let contentType =
    file.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

  if (!contentType || contentType === "application/octet-stream") {
    const extension = file.filename.split(".").at(-1)?.toLowerCase() ?? "";
    contentType = EXTENSION_TYPES.get(extension) ?? "";
  }

  if (contentType === "application/pdf") return { kind: "pdf", contentType };

  if (
    isComposerInlineImageContentType(contentType) ||
    contentType === "image/avif" ||
    contentType === "image/bmp"
  ) {
    return { kind: "image", contentType };
  }

  if (TEXT_TYPES.has(contentType)) {
    const charset =
      /;\s*charset\s*=\s*"?([a-zA-Z0-9_-]+)/iu.exec(file.contentType)?.[1] ??
      "utf-8";

    // XML and other structured text must never execute as same-origin documents.
    return { kind: "text", contentType: `text/plain; charset=${charset}` };
  }

  return null;
}
