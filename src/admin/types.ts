import type { api, SuccessfulResponse } from "@/lib/api";
import type { WebhookEventType } from "../../shared/webhooks";

type AdminStateResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.admin.state.$get>>
>;

export type AdminMailbox = AdminStateResponse["mailboxes"][number];
export type AdminDomain = AdminStateResponse["domains"][number];
export type AdminRouting = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.admin.routing.$get>>
>;
export type AdminUser = AdminStateResponse["users"][number];
export type MailboxMemberPermission = AdminMailbox["members"][number];

export type InvitationInput = {
  name: string;
  email: string;
};

export type UpdateUserInput = Pick<AdminUser, "name"> & {
  status?: "active" | "disabled";
};

export type AdminGroup = AdminStateResponse["groups"][number];
export type AdminOidcClient = AdminStateResponse["oidcClients"][number];
export type AdminSamlApplication = AdminStateResponse["samlApplications"][number];
export type AdminSamlProvider = AdminStateResponse["samlProvider"];

type AdminSamlApplicationDetailsResponse = SuccessfulResponse<
  Awaited<
    ReturnType<typeof api.api.admin["saml-applications"][":id"]["$get"]>
  >
>;

export type AdminSamlApplicationDetails = AdminSamlApplication
  & Pick<AdminSamlApplicationDetailsResponse, "spSigningCertificate">;

type AdminWebhooksResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.admin.webhooks.$get>>
>;

export type AdminWebhook = AdminWebhooksResponse["webhooks"][number];
export type AdminWebhookDelivery = AdminWebhooksResponse["deliveries"][number];

export type WebhookInput = {
  name: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
};

export type CreateMailboxInput = {
  displayName: string;
  address: string;
  ownerUserId: string | null;
  members: MailboxMemberPermission[];
};

export type DomainInput = {
  name: string;
  cloudflareZoneId: string | null;
};

export type UpdateMailboxInput = Pick<
  CreateMailboxInput,
  "displayName" | "members"
>;
