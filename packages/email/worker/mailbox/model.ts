export {
  deliveryStatuses,
  type DeliveryStatusName,
  type RecipientDeliveryStatus,
} from "../../shared/mail";

export type MailAddress = {
  address: string;
  name: string | null;
};

export type {
  InboundAuthentication,
  ListUnsubscribe,
} from "../../shared/mail-authentication";

export type {
  DeliveryFacts,
  SenderIntel,
} from "../../shared/mail-sender-intel";

export type StoredEmailAuthentication =
  import("../../shared/mail-authentication").InboundAuthentication;

export type MailboxAiConfiguration = {
  instructions: string;
  confidenceThreshold: number;
};

export type EmailAiClassification = {
  source: "ai";
  model: string;
  processedAt: number;
  spam: boolean;
  spamConfidence: number;
  folderId: string | null;
  folderConfidence: number;
  reason: string;
};

/** What sender blocks decided for an incoming message at ingestion. */
export type EmailScreening = {
  blocked: "mailbox" | "workspace" | null;
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
