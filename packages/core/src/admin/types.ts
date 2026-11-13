import type { WebhookEventType } from "../../shared/webhooks";
import type { api, SuccessfulResponse } from "../lib/api";

type AdminStateResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.admin.state.$get>>
>;

export type AdminMailbox = AdminStateResponse["mailboxes"][number];

export type AdminUser = AdminStateResponse["users"][number];

export type AdminPermission =
  AdminStateResponse["availablePermissions"][number];

export type InvitationInput = {
  name: string;
  email: string;
};

export type UpdateUserInput = Pick<AdminUser, "name"> & {
  status?: "active" | "disabled";
};

export type AdminTeam = AdminStateResponse["teams"][number];

export type AdminTeamMember = AdminTeam["members"][number];

export type AdminOidcClient = AdminStateResponse["oidcClients"][number];

export type AdminSamlApplication =
  AdminStateResponse["samlApplications"][number];

export type AdminSamlProvider = AdminStateResponse["samlProvider"];

export type AdminOidcProvider = AdminStateResponse["oidcProvider"];

export type SamlMetadataDraft = SuccessfulResponse<
  Awaited<
    ReturnType<
      (typeof api.api.admin)["saml-applications"]["parse-metadata"]["$post"]
    >
  >
>["draft"];

type AdminSamlApplicationDetailsResponse = SuccessfulResponse<
  Awaited<
    ReturnType<(typeof api.api.admin)["saml-applications"][":id"]["$get"]>
  >
>;

export type AdminSamlApplicationDetails = AdminSamlApplication &
  Pick<AdminSamlApplicationDetailsResponse, "spSigningCertificate">;

type AdminWebhooksResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.admin.webhooks.$get>>
>;

export type AdminWebhook = AdminWebhooksResponse["webhooks"][number];

export type AdminWebhookDelivery = AdminWebhooksResponse["deliveries"][number];

export type AdminWebhookMailbox = AdminWebhooksResponse["mailboxes"][number];

export type WebhookInput = {
  name: string;
  url: string;
  events: WebhookEventType[];
  /** For mail events: the mailboxes whose mail it receives. */
  mailboxIds: string[];
  enabled: boolean;
};
