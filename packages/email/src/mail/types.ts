import type { SuccessfulResponse } from "@open-workspace/core/ui";

import type { mailApi } from "../lib/mail-api";

export type {
  MailboxState,
  RecipientDeliveryStatus,
  ReplyAction,
  ReplyActionMode,
  ReplyPlan,
  TransportState,
} from "../../shared/mail";

type MailboxesResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof mailApi.api.mail.mailboxes.$get>>
>;

type FoldersResponse = SuccessfulResponse<
  Awaited<
    ReturnType<(typeof mailApi.api.mail.mailboxes)[":id"]["folders"]["$get"]>
  >
>;

type MailboxAiGet = (typeof mailApi.api.mail.mailboxes)[":id"]["ai"]["$get"];

type MailboxAiSettingsResponse = SuccessfulResponse<
  Awaited<ReturnType<MailboxAiGet>>
>;

type ConversationsResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof mailApi.api.mail.conversations.$get>>
>;

type ConversationResponse = SuccessfulResponse<
  Awaited<ReturnType<(typeof mailApi.api.mail.conversations)[":id"]["$get"]>>
>;

export type Mailbox = MailboxesResponse["mailboxes"][number];

export type MailFolder = FoldersResponse["folders"][number];

export type MailboxAiSettings = MailboxAiSettingsResponse["settings"];

export type MailboxAiConfiguration = MailboxAiSettings["configuration"];

export type ConversationSummary =
  ConversationsResponse["conversations"][number];

export type MessageDetail = ConversationResponse["messages"][number];

export type MessageAttachment = MessageDetail["attachments"][number];

export type Folder = string;

type MailRulesRoute = (typeof mailApi.api.mail.mailboxes)[":id"]["rules"];

export type MailRule = SuccessfulResponse<
  Awaited<ReturnType<MailRulesRoute["$get"]>>
>["rules"][number];

export type MailRuleInput = Parameters<MailRulesRoute["$post"]>[0]["json"];
