export type PdfPreviewStatus = "pending" | "ready" | "failed";

export const MAX_OFFICE_PREVIEW_BYTES = 20 * 1024 * 1024;

const OFFICE_EXTENSIONS = new Set([
  "doc",
  "docx",
  "docm",
  "xls",
  "xlsx",
  "xlsm",
  "ppt",
  "pptx",
  "pptm",
  "odt",
  "ods",
  "odp",
  "rtf",
]);

export function officePreviewExtension(filename: string) {
  const extension = /\.([^.]+)$/u.exec(filename)?.[1]?.toLowerCase();

  return extension && OFFICE_EXTENSIONS.has(extension) ? extension : null;
}

export function officePreviewKey(sourceKey: string) {
  return `${sourceKey}.preview.pdf`;
}

export type OfficePreviewJob = {
  mailboxId: string;
  messageId: string;
  attachmentId: string;
  sourceKey: string;
};

export const OFFICE_PREVIEW_QUEUE = "openworkspace-office-previews";
