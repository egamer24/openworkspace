export {
  deliveryStatuses,
  type DeliveryStatusName,
  type RecipientDeliveryStatus,
} from "../../shared/mail";

export type MailAddress = {
  address: string;
  name: string | null;
};

export type EmailAuthenticationResults = {
  source: "cloudflare";
  checkedAt: number;
  eventAt: number;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  arc: string | null;
  isSpam: boolean;
  spamScore: number | null;
  spamThreshold: number | null;
};

export const spamVerdicts = ["clean", "suspicious", "spam"] as const;
export type SpamVerdict = (typeof spamVerdicts)[number];

/** One local spam signal: positive points raise the score, negative lower it. */
export type SpamReason = {
  points: number;
  reason: string;
};

export type MailboxAiConfiguration = {
  instructions: string;
  confidenceThreshold: number;
};

export type EmailAiClassification = {
  source: "workers-ai";
  model: string;
  processedAt: number;
  spam: boolean;
  spamConfidence: number;
  folderId: string | null;
  folderConfidence: number;
  reason: string;
};

export type StoredAttachment = {
  id: string;
  r2Key: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  disposition: "attachment" | "inline";
  delivery: "attached" | "download_link";
  downloadTokenHash: string | null;
  downloadExpiresAt: number | null;
  pdfPreviewStatus?: import("../../shared/office-preview").PdfPreviewStatus;
};

export type DraftAttachment = {
  /** The composer's asset id, referenced from the editor HTML. */
  assetId: string;
  uploadId: string;
  filename: string;
  contentType: string;
  size: number;
  intent: "attachment" | "inline";
  contentId: string | null;
};
