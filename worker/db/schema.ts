import { sql } from "drizzle-orm";
import { accessLinkKinds, accountApiTokenScopes } from "../../shared/auth";
import {
  domainOnboardingStatuses,
  domainOnboardingSteps as onboardingStepNames,
} from "../../shared/domain-onboarding";
import {
  webhookDeliveryStatuses,
  webhookEventTypes,
} from "../../shared/webhooks";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    role: text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    status: text("status", { enum: ["invited", "active", "disabled"] })
      .notNull()
      .default("invited"),
    ...timestamps,
  },
  (table) => [
    index("users_status_idx").on(table.status),
    index("users_role_idx").on(table.role),
  ],
);

export const domains = sqliteTable(
  "domains",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    cloudflareZoneId: text("cloudflare_zone_id"),
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    // Unknown recipients are rejected unless this names a catch-all mailbox.
    unknownRecipientMailboxId: text("unknown_recipient_mailbox_id")
      .references((): AnySQLiteColumn => mailboxes.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("domains_name_unique").on(table.name),
    uniqueIndex("domains_primary_unique")
      .on(table.isPrimary)
      .where(sql`${table.isPrimary} = 1`),
  ],
);

export const domainOnboardingSteps = sqliteTable(
  "domain_onboarding_steps",
  {
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    step: text("step", { enum: onboardingStepNames }).notNull(),
    status: text("status", { enum: domainOnboardingStatuses }).notNull(),
    detail: text("detail"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.domainId, table.step] }),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    localPart: text("local_part").notNull(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("mailboxes_address_unique").on(table.domainId, table.localPart),
    uniqueIndex("mailboxes_owner_primary_unique")
      .on(table.ownerUserId)
      .where(sql`${table.isPrimary} = 1`),
    index("mailboxes_owner_idx").on(table.ownerUserId),
    index("mailboxes_domain_idx").on(table.domainId),
    check(
      "mailboxes_primary_owner_check",
      sql`${table.isPrimary} = 0 OR ${table.ownerUserId} IS NOT NULL`,
    ),
  ],
);

/** Email Routing destination addresses (account-level in Cloudflare). */
export const forwardingDestinations = sqliteTable(
  "forwarding_destinations",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    cloudflareId: text("cloudflare_id"),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [uniqueIndex("forwarding_destinations_email_unique").on(table.email)],
);

/**
 * Domain-level addresses resolved by the email() handler. mailboxId stores the
 * message (an alias, or a mailbox's own address when it also forwards); a null
 * mailboxId is a forward-only address.
 */
export const routingAddresses = sqliteTable(
  "routing_addresses",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    localPart: text("local_part").notNull(),
    mailboxId: text("mailbox_id")
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    keepCopy: integer("keep_copy", { mode: "boolean" }).notNull().default(true),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Self-service receive-only address owned by createdByUserId. */
    throwaway: integer("throwaway", { mode: "boolean" }).notNull().default(false),
    /** Private note for a throwaway, such as the site it was given to. */
    label: text("label"),
    /** While set, mail to the address is rejected instead of delivered. */
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("routing_addresses_address_unique").on(table.domainId, table.localPart),
    index("routing_addresses_mailbox_idx").on(table.mailboxId),
    index("routing_addresses_creator_idx").on(table.createdByUserId),
  ],
);

export const routingAddressDestinations = sqliteTable(
  "routing_address_destinations",
  {
    addressId: text("address_id")
      .notNull()
      .references(() => routingAddresses.id, { onDelete: "cascade" }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => forwardingDestinations.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.addressId, table.destinationId] }),
    index("routing_address_destinations_destination_idx").on(table.destinationId),
  ],
);

export const mailboxMembers = sqliteTable(
  "mailbox_members",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    canSend: integer("can_send", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.userId] }),
    index("mailbox_members_user_idx").on(table.userId),
  ],
);

export const mailboxSignatures = sqliteTable(
  "mailbox_signatures",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Sanitized HTML, as shown in the composer and sent in HTML bodies. */
    html: text("html").notNull(),
    /** Plain-text rendering of `html`, for text bodies and the reply box. */
    text: text("text").notNull(),
    useOnNew: integer("use_on_new", { mode: "boolean" }).notNull().default(true),
    useOnReply: integer("use_on_reply", { mode: "boolean" }).notNull().default(true),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.userId] }),
    index("mailbox_signatures_user_idx").on(table.userId),
  ],
);

export const mailboxNotificationPreferences = sqliteTable(
  "mailbox_notification_preferences",
  {
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.mailboxId, table.userId] }),
    index("mailbox_notification_preferences_user_idx").on(table.userId),
  ],
);

export const passkeyCredentials = sqliteTable(
  "passkey_credentials",
  {
    credentialId: text("credential_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports", { mode: "json" }).$type<string[]>(),
    deviceType: text("device_type", {
      enum: ["singleDevice", "multiDevice"],
    }).notNull(),
    backedUp: integer("backed_up", { mode: "boolean" })
      .notNull()
      .default(false),
    label: text("label"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("passkey_credentials_user_idx").on(table.userId)],
);

export const accessLinks = sqliteTable(
  "access_links",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: accessLinkKinds }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("access_links_token_hash_unique").on(table.tokenHash),
    index("access_links_user_kind_idx").on(table.userId, table.kind),
    index("access_links_expiry_idx").on(table.expiresAt),
  ],
);

/**
 * A claim is inserted in the same D1 batch as the credential. The primary key
 * turns invitation and recovery redemption into an atomic, exactly-once
 * operation even if two WebAuthn ceremonies finish at the same time.
 */
export const accessLinkClaims = sqliteTable("access_link_claims", {
  accessLinkId: text("access_link_id")
    .primaryKey()
    .references(() => accessLinks.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull(),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const authChallenges = sqliteTable(
  "auth_challenges",
  {
    id: text("id").primaryKey(),
    challenge: text("challenge").notNull(),
    kind: text("kind", {
      enum: ["bootstrap", ...accessLinkKinds, "authentication"],
    }).notNull(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    accessLinkId: text("access_link_id").references(() => accessLinks.id, {
      onDelete: "cascade",
    }),
    rpId: text("rp_id").notNull(),
    origin: text("origin").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("auth_challenges_expiry_idx").on(table.expiresAt),
    index("auth_challenges_user_idx").on(table.userId),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    location: text("location"),
    ipAddress: text("ip_address"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_created_idx").on(table.userId, table.createdAt),
    index("sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const accountApiTokens = sqliteTable(
  "account_api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    scope: text("scope", { enum: accountApiTokenScopes })
      .notNull()
      .default("full"),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("account_api_tokens_hash_unique").on(table.tokenHash),
    index("account_api_tokens_user_idx").on(table.userId),
  ],
);

export const webhookEndpoints = sqliteTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    events: text("events", { mode: "json" })
      .$type<Array<(typeof webhookEventTypes)[number]>>()
      .notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // Delivery needs the original secret to calculate an HMAC. It is never
    // returned again after create/rotate and is only read by the queue worker.
    signingSecret: text("signing_secret").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    index("webhook_endpoints_enabled_idx").on(table.enabled),
  ],
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    source: text("source", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text("status", { enum: webhookDeliveryStatuses })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    error: text("error"),
    lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_event_endpoint_unique").on(
      table.eventId,
      table.webhookId,
    ),
    index("webhook_deliveries_webhook_created_idx").on(
      table.webhookId,
      table.createdAt,
    ),
    index("webhook_deliveries_created_idx").on(table.createdAt),
  ],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The session that last bound this browser; pushes stop when it is revoked. */
    sessionId: text("session_id"),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("push_subscriptions_endpoint_unique").on(table.endpoint),
    index("push_subscriptions_user_idx").on(table.userId),
  ],
);

export const oidcClients = sqliteTable(
  "oidc_clients",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    clientType: text("client_type", {
      enum: ["public", "confidential"],
    }).notNull(),
    secretHash: text("secret_hash"),
    accessPolicy: text("access_policy", {
      enum: ["all_active_users", "selected_users"],
    })
      .notNull()
      .default("selected_users"),
    redirectUris: text("redirect_uris", { mode: "json" })
      .$type<string[]>()
      .notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    allowedOrigins: text("allowed_origins", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    allowedScopes: text("allowed_scopes", { mode: "json" })
      .$type<string[]>()
      .notNull(),
    trusted: integer("trusted", { mode: "boolean" }).notNull().default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    index("oidc_clients_enabled_idx").on(table.enabled),
    index("oidc_clients_created_by_idx").on(table.createdByUserId),
  ],
);

export const oidcClientAssignments = sqliteTable(
  "oidc_client_assignments",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => oidcClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.userId] }),
    index("oidc_client_assignments_user_idx").on(table.userId),
  ],
);

export const samlApplications = sqliteTable(
  "saml_applications",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    entityId: text("entity_id").notNull(),
    acsUrl: text("acs_url").notNull(),
    nameIdFormat: text("name_id_format", {
      enum: ["email", "persistent"],
    })
      .notNull()
      .default("email"),
    accessPolicy: text("access_policy", {
      enum: ["all_active_users", "selected_users"],
    })
      .notNull()
      .default("selected_users"),
    emailAttributeName: text("email_attribute_name").notNull(),
    nameAttributeName: text("name_attribute_name").notNull(),
    groupsAttributeName: text("groups_attribute_name"),
    signResponse: integer("sign_response", { mode: "boolean" })
      .notNull()
      .default(true),
    requireSignedAuthnRequests: integer("require_signed_authn_requests", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    spSigningCertificate: text("sp_signing_certificate"),
    allowIdpInitiated: integer("allow_idp_initiated", { mode: "boolean" })
      .notNull()
      .default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saml_applications_entity_id_unique").on(table.entityId),
    index("saml_applications_enabled_idx").on(table.enabled),
    index("saml_applications_created_by_idx").on(table.createdByUserId),
  ],
);

export const samlApplicationAssignments = sqliteTable(
  "saml_application_assignments",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => samlApplications.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.applicationId, table.userId] }),
    index("saml_application_assignments_user_idx").on(table.userId),
  ],
);

export const samlPairwiseSubjects = sqliteTable(
  "saml_pairwise_subjects",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => samlApplications.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    nameId: text("name_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.applicationId, table.userId] }),
    uniqueIndex("saml_pairwise_subjects_name_id_unique").on(table.nameId),
    index("saml_pairwise_subjects_user_idx").on(table.userId),
  ],
);

export const identityGroups = sqliteTable(
  "identity_groups",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("identity_groups_slug_unique").on(table.slug),
    index("identity_groups_name_idx").on(table.name),
  ],
);

export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => identityGroups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index("group_members_user_idx").on(table.userId),
  ],
);

export const oidcClientGroupClaims = sqliteTable(
  "oidc_client_group_claims",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => oidcClients.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => identityGroups.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.groupId] }),
    index("oidc_client_group_claims_group_idx").on(table.groupId),
  ],
);

export const samlApplicationGroupClaims = sqliteTable(
  "saml_application_group_claims",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => samlApplications.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => identityGroups.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.applicationId, table.groupId] }),
    index("saml_application_group_claims_group_idx").on(table.groupId),
  ],
);

export const samlAuthnRequests = sqliteTable(
  "saml_authn_requests",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => samlApplications.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    spRequestId: text("sp_request_id"),
    acsUrl: text("acs_url").notNull(),
    relayState: text("relay_state"),
    requestedSpNameQualifier: text("requested_sp_name_qualifier"),
    allowNameIdCreation: integer("allow_name_id_creation", { mode: "boolean" })
      .notNull()
      .default(false),
    status: text("status", {
      enum: ["awaiting_login", "authenticated", "responded"],
    })
      .notNull()
      .default("awaiting_login"),
    browserSecretHash: text("browser_secret_hash"),
    authTime: integer("auth_time", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("saml_authn_requests_sp_request_unique").on(
      table.applicationId,
      table.spRequestId,
    ),
    index("saml_authn_requests_expiry_idx").on(table.expiresAt),
    index("saml_authn_requests_user_idx").on(table.userId),
    index("saml_authn_requests_status_idx").on(table.status),
  ],
);

export const oidcAuthorizationRequests = sqliteTable(
  "oidc_authorization_requests",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oidcClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["awaiting_login", "authenticated", "awaiting_consent"],
    })
      .notNull()
      .default("awaiting_consent"),
    browserSecretHash: text("browser_secret_hash"),
    forceConsent: integer("force_consent", { mode: "boolean" })
      .notNull()
      .default(false),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    state: text("state"),
    nonce: text("nonce"),
    codeChallenge: text("code_challenge").notNull(),
    authTime: integer("auth_time", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("oidc_authorization_requests_expiry_idx").on(table.expiresAt),
    index("oidc_authorization_requests_user_idx").on(table.userId),
    index("oidc_authorization_requests_status_idx").on(table.status),
  ],
);

export const oidcAuthorizationCodes = sqliteTable(
  "oidc_authorization_codes",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oidcClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    nonce: text("nonce"),
    codeChallenge: text("code_challenge").notNull(),
    authTime: integer("auth_time", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    issuedAccessTokenHash: text("issued_access_token_hash"),
    issuedRefreshFamilyId: text("issued_refresh_family_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("oidc_authorization_codes_expiry_idx").on(table.expiresAt),
    index("oidc_authorization_codes_user_client_idx").on(
      table.userId,
      table.clientId,
    ),
  ],
);

export const oidcGrants = sqliteTable(
  "oidc_grants",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => oidcClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.userId] }),
    index("oidc_grants_user_idx").on(table.userId),
  ],
);

export const oidcAccessTokens = sqliteTable(
  "oidc_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    familyId: text("family_id").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oidcClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    authTime: integer("auth_time", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("oidc_access_tokens_expiry_idx").on(table.expiresAt),
    index("oidc_access_tokens_family_idx").on(table.familyId),
    index("oidc_access_tokens_user_client_idx").on(
      table.userId,
      table.clientId,
    ),
  ],
);

export const oidcRefreshTokens = sqliteTable(
  "oidc_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    familyId: text("family_id").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oidcClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    authTime: integer("auth_time", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    replacedByTokenHash: text("replaced_by_token_hash"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("oidc_refresh_tokens_family_idx").on(table.familyId),
    index("oidc_refresh_tokens_expiry_idx").on(table.expiresAt),
    index("oidc_refresh_tokens_user_client_idx").on(
      table.userId,
      table.clientId,
    ),
  ],
);

export const oidcAuditEvents = sqliteTable(
  "oidc_audit_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    subjectUserId: text("subject_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    clientId: text("client_id"),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("oidc_audit_events_created_idx").on(table.createdAt),
    index("oidc_audit_events_client_idx").on(table.clientId),
  ],
);

export const rateLimitBuckets = sqliteTable(
  "rate_limit_buckets",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(1),
    windowEndsAt: integer("window_ends_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("rate_limit_buckets_expiry_idx").on(table.windowEndsAt),
  ],
);

/**
 * One row per dated snapshot in BACKUP_STORAGE. The cursor columns let the
 * scheduled job resume in bounded batches; `mailboxId` is null once every
 * mailbox has been written and only retention remains.
 */
export const backupRuns = sqliteTable("backup_runs", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["running", "completed"] }).notNull(),
  mailboxId: text("mailbox_id"),
  mailboxAddress: text("mailbox_address"),
  emailCursor: text("email_cursor"),
  part: integer("part").notNull().default(0),
  messageCount: integer("message_count").notNull().default(0),
  byteCount: integer("byte_count").notNull().default(0),
  newObjectCount: integer("new_object_count").notNull().default(0),
  errorsJson: text("errors_json", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default([]),
  leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});

/**
 * Content-addressed .eml objects in BACKUP_STORAGE. `lastRunId` is the newest
 * snapshot that references the object, so anything older than the oldest
 * retained snapshot is unreferenced and safe to delete.
 */
export const backupObjects = sqliteTable(
  "backup_objects",
  {
    sha256: text("sha256").primaryKey(),
    size: integer("size").notNull(),
    lastRunId: text("last_run_id").notNull(),
  },
  (table) => [index("backup_objects_last_run_idx").on(table.lastRunId)],
);

export const driveItems = sqliteTable(
  "drive_items",
  {
    id: text("id").primaryKey(),
    // Items inside a shared folder stay owned (and quota-charged) by the
    // folder owner, even when an editor creates them.
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    parentId: text("parent_id").references(
      (): AnySQLiteColumn => driveItems.id,
      { onDelete: "cascade" },
    ),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["file", "folder"] }).notNull(),
    status: text("status", { enum: ["pending", "ready"] })
      .notNull()
      .default("ready"),
    size: integer("size").notNull().default(0),
    contentType: text("content_type"),
    r2Key: text("r2_key"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    trashedAt: integer("trashed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    // Names are unique (case-insensitively) among live siblings; trashed
    // items step aside so a restore can report the conflict instead.
    uniqueIndex("drive_items_root_name_unique")
      .on(table.ownerUserId, sql`lower(${table.name})`)
      .where(sql`${table.parentId} IS NULL AND ${table.trashedAt} IS NULL`),
    uniqueIndex("drive_items_child_name_unique")
      .on(table.parentId, sql`lower(${table.name})`)
      .where(sql`${table.parentId} IS NOT NULL AND ${table.trashedAt} IS NULL`),
    index("drive_items_parent_idx").on(table.parentId),
    index("drive_items_owner_idx").on(table.ownerUserId, table.trashedAt),
  ],
);

export const driveShares = sqliteTable(
  "drive_shares",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => driveItems.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.userId] }),
    index("drive_shares_user_idx").on(table.userId),
  ],
);

export const driveLinks = sqliteTable(
  "drive_links",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => driveItems.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    access: text("access", { enum: ["view", "download"] }).notNull(),
    passwordHash: text("password_hash"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: integer("last_accessed_at", { mode: "timestamp_ms" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("drive_links_token_hash_unique").on(table.tokenHash),
    index("drive_links_item_idx").on(table.itemId),
  ],
);

export const driveQuotas = sqliteTable("drive_quotas", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  quotaBytes: integer("quota_bytes").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * Secret ICS feed URLs resolve here by token hash; the calendar itself lives
 * in the owner's calendar Durable Object.
 */
export const calendarFeeds = sqliteTable(
  "calendar_feeds",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calendarId: text("calendar_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("calendar_feeds_calendar_unique").on(table.userId, table.calendarId),
  ],
);

/** Public booking page handle (`/book/<handle>`), one per user. */
export const bookingHandles = sqliteTable(
  "booking_handles",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [uniqueIndex("booking_handles_handle_unique").on(table.handle)],
);

export type User = typeof users.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
export type DriveItem = typeof driveItems.$inferSelect;
