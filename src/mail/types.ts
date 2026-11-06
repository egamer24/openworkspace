import type { api, SuccessfulResponse } from "@/lib/api";

export type {
  MailboxState,
  RecipientDeliveryStatus,
  ReplyAction,
  ReplyActionMode,
  ReplyPlan,
  TransportState,
} from "../../shared/mail";

type MailboxesResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.mailboxes.$get>>
>;
type FoldersResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.mailboxes[":id"]["folders"]["$get"]>>
>;
type MailboxAiGet = typeof api.api.mail.mailboxes[":id"]["ai"]["$get"];
type MailboxAiSettingsResponse = SuccessfulResponse<
  Awaited<ReturnType<MailboxAiGet>>
>;
type SpamSettingsResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.mailboxes[":id"]["spam"]["$get"]>>
>;
type ConversationsResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.conversations.$get>>
>;
type ConversationResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.conversations[":id"]["$get"]>>
>;

export type Mailbox = MailboxesResponse["mailboxes"][number];
export type MailFolder = FoldersResponse["folders"][number];
export type MailboxAiSettings = MailboxAiSettingsResponse["settings"];
export type MailboxAiConfiguration = MailboxAiSettings["configuration"];
export type SpamSettings = SpamSettingsResponse["settings"];
export type ConversationSummary =
  ConversationsResponse["conversations"][number];
export type MessageDetail = ConversationResponse["messages"][number];
export type MessageAttachment = MessageDetail["attachments"][number];

export type Folder = string;
