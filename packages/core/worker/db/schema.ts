import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  sqliteView,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { accessLinkKinds } from "../../shared/auth";
import { oidcClientRegistrations } from "../../shared/oidc";
import { webhookDeliveryStatuses } from "../../shared/webhooks";
import type { WebhookEventType } from "../../shared/webhooks";
import { listPostingPolicies, mailboxDeliveries } from "../../shared/workspace";
import type { WorkspacePermission } from "../../shared/workspace";
import type {
  ChallengePayload,
  OidcAuditDetail,
  WebhookEventSource,
} from "./json";

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
    /** The avatar's key (shared/avatar.ts, auth/avatar.ts); null without one. */
    avatarId: text("avatar_id"),
    role: text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    status: text("status", { enum: ["invited", "active", "disabled"] })
      .notNull()
      .default("invited"),
    /** What a member may manage; administrators may manage everything. */
    permissions: text("permissions", { mode: "json" })
      .$type<WorkspacePermission[]>()
      .notNull()
      .default(sql`'[]'`),
    ...timestamps,
  },
  (table) => [
    index("users_status_idx").on(table.status),
    index("users_role_idx").on(table.role),
  ]
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
    /** One of `mailDomains` in alchemy.run.ts, lowercase; checked in code, not by a foreign key. */
    domain: text("domain").notNull(),
    displayName: text("display_name").notNull(),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    /** The team whose members share this mailbox; null for personal mailboxes. */
    teamId: text("team_id").references(() => teams.id, {
      onDelete: "restrict",
    }),
    /**
     * An address with its own mailbox (inbox); for a team, a mailing list
     * that copies each message into every member's own mailbox (list); an
     * alias that delivers into `aliasOf`; or a forward to `forwardTo`.
     * Only an inbox can be primary or a catch-all (admin/mailbox-routes.ts).
     */
    delivery: text("delivery", { enum: mailboxDeliveries })
      .notNull()
      .default("inbox"),
    /**
     * The inbox or list an alias delivers into, of the same owner or team.
     * Deleting a mailbox deletes its aliases first, each as an address of its
     * own, so nothing relies on a cascade (restrict catches a missed one).
     */
    aliasOf: text("alias_of").references((): AnySQLiteColumn => mailboxes.id, {
      onDelete: "restrict",
    }),
    /** A forward's outside addresses, each an Email Routing destination. */
    forwardTo: text("forward_to", { mode: "json" }).$type<string[]>(),
    /** Gets mail for addresses on its domain that nothing else takes. */
    catchAll: integer("catch_all", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Who may write to a mailing list; unused for inboxes. */
    listPosting: text("list_posting", { enum: listPostingPolicies })
      .notNull()
      .default("workspace"),
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("mailboxes_address_unique").on(table.domain, table.localPart),
    uniqueIndex("mailboxes_owner_primary_unique")
      .on(table.ownerUserId)
      .where(sql`${table.isPrimary} = 1`),
    index("mailboxes_owner_idx").on(table.ownerUserId),
    index("mailboxes_team_idx").on(table.teamId),
    index("mailboxes_alias_of_idx").on(table.aliasOf),
    uniqueIndex("mailboxes_catch_all_unique")
      .on(table.domain)
      .where(sql`${table.catchAll} = 1`),
    check(
      "mailboxes_primary_owner_check",
      sql`${table.isPrimary} = 0 OR ${table.ownerUserId} IS NOT NULL`
    ),
  ]
);

/**
 * Each team's members: everyone active in the workspace for an "everyone"
 * team, otherwise the people added to it. Derived, never written.
 */
export const teamMembership = sqliteView("team_membership", {
  teamId: text("team_id").notNull(),
  userId: text("user_id").notNull(),
  canSend: integer("can_send", { mode: "boolean" }).notNull(),
}).as(sql`
  SELECT team_members.team_id, team_members.user_id, team_members.can_send
  FROM team_members
  INNER JOIN teams ON teams.id = team_members.team_id
  WHERE teams.everyone = 0
  UNION ALL
  SELECT teams.id, users.id, 1
  FROM teams
  INNER JOIN users ON users.status = 'active'
  WHERE teams.everyone = 1
`);

/**
 * Who may open each mailbox: the owner of a personal mailbox, or the members
 * of the team a shared inbox belongs to. Mailing lists, aliases and forwards
 * are never opened; their mail lands in other mailboxes. Derived, never written.
 */
export const mailboxAccess = sqliteView("mailbox_access", {
  mailboxId: text("mailbox_id").notNull(),
  userId: text("user_id").notNull(),
  canSend: integer("can_send", { mode: "boolean" }).notNull(),
}).as(sql`
  SELECT id AS mailbox_id, owner_user_id AS user_id, 1 AS can_send
  FROM mailboxes
  WHERE owner_user_id IS NOT NULL AND delivery = 'inbox'
  UNION ALL
  SELECT mailboxes.id, team_membership.user_id, team_membership.can_send
  FROM mailboxes
  INNER JOIN team_membership ON team_membership.team_id = mailboxes.team_id
  WHERE mailboxes.delivery = 'inbox'
`);

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
  (table) => [index("passkey_credentials_user_idx").on(table.userId)]
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
  ]
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
    payload: text("payload", { mode: "json" }).$type<ChallengePayload>(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("auth_challenges_expiry_idx").on(table.expiresAt),
    index("auth_challenges_user_idx").on(table.userId),
  ]
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
  ]
);

export const webhookEndpoints = sqliteTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    events: text("events", { mode: "json" })
      .$type<WebhookEventType[]>()
      .notNull(),
    /**
     * For mail events, the mailboxes whose mail it receives, as long as the
     * person who saved it (created_by_user_id) can open them. An endpoint
     * declared in alchemy.run.ts covers every mailbox.
     */
    mailboxIds: text("mailbox_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // Delivery needs the original secret to calculate an HMAC. It is never
    // returned again after create/rotate and is only read by the queue worker.
    signingSecret: text("signing_secret").notNull(),
    /** "deployment" when declared in alchemy.run.ts; the admin UI cannot edit it then. */
    managedBy: text("managed_by", { enum: ["deployment"] }),
    /** Whoever last saved it; its mailboxes' mail follows their access. */
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [index("webhook_endpoints_enabled_idx").on(table.enabled)]
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
      .$type<WebhookEventSource>()
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
      table.webhookId
    ),
    index("webhook_deliveries_webhook_created_idx").on(
      table.webhookId,
      table.createdAt
    ),
    index("webhook_deliveries_created_idx").on(table.createdAt),
  ]
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
    redirectUris: text("redirect_uris", { mode: "json" })
      .$type<string[]>()
      .notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    /** OpenID Connect Back-Channel Logout: told when a person loses access. */
    backchannelLogoutUri: text("backchannel_logout_uri"),
    allowedOrigins: text("allowed_origins", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    allowedScopes: text("allowed_scopes", { mode: "json" })
      .$type<string[]>()
      .notNull(),
    trusted: integer("trusted", { mode: "boolean" }).notNull().default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /**
     * How the client came to exist: added by an administrator, registered
     * itself (RFC 7591), or identified by its metadata document URL
     * (Client ID Metadata Documents). Self-registered clients are MCP clients.
     */
    registration: text("registration", { enum: oidcClientRegistrations })
      .notNull()
      .default("admin"),
    /** When a metadata-document client's document was last fetched. */
    metadataFetchedAt: integer("metadata_fetched_at", { mode: "timestamp_ms" }),
    /**
     * Whether authorization requests must carry PKCE (S256). On for every new
     * client; turned off only for apps that cannot send it.
     */
    requirePkce: integer("require_pkce", { mode: "boolean" })
      .notNull()
      .default(true),
    /** "deployment" when declared in alchemy.run.ts; the admin UI cannot edit it then. */
    managedBy: text("managed_by", { enum: ["deployment"] }),
    /** For self-registered clients, the workspace's first administrator. */
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    index("oidc_clients_enabled_idx").on(table.enabled),
    index("oidc_clients_created_by_idx").on(table.createdByUserId),
  ]
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
    /** Optional given-name and family-name attributes, split from the person's name. */
    firstNameAttributeName: text("first_name_attribute_name"),
    lastNameAttributeName: text("last_name_attribute_name"),
    /** "deployment" when declared in alchemy.run.ts; the admin UI cannot edit it then. */
    managedBy: text("managed_by", { enum: ["deployment"] }),
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
  ]
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
  ]
);

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Stable name released to SSO applications in the groups claim. */
    slug: text("slug").notNull(),
    description: text("description"),
    /** Everyone active in the workspace belongs; team_members is ignored. */
    everyone: integer("everyone", { mode: "boolean" }).notNull().default(false),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("teams_slug_unique").on(table.slug),
    index("teams_name_idx").on(table.name),
  ]
);

export const teamMembers = sqliteTable(
  "team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Whether this member may send from the team's mailboxes. */
    canSend: integer("can_send", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId] }),
    index("team_members_user_idx").on(table.userId),
  ]
);

/** Teams whose members may sign in to an OIDC client, and how each is named to it. */
export const oidcClientAccessTeams = sqliteTable(
  "oidc_client_access_teams",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => oidcClients.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /**
     * What the app receives for this team in groups: this value, or else the
     * team's handle. Everyone is sent only with a value.
     */
    sentAs: text("sent_as"),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.teamId] }),
    index("oidc_client_access_teams_team_idx").on(table.teamId),
  ]
);

/** Teams whose members may sign in to a SAML application, and how each is named to it. */
export const samlApplicationAccessTeams = sqliteTable(
  "saml_application_access_teams",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => samlApplications.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /**
     * What the app receives for this team in groups: this value, or else the
     * team's handle. Everyone is sent only with a value.
     */
    sentAs: text("sent_as"),
  },
  (table) => [
    primaryKey({ columns: [table.applicationId, table.teamId] }),
    index("saml_application_access_teams_team_idx").on(table.teamId),
  ]
);

/**
 * Who may sign in to each OIDC client: active members of its access teams.
 * Clients that registered themselves (MCP) are open to everyone active.
 */
export const oidcClientAccess = sqliteView("oidc_client_access", {
  clientId: text("client_id").notNull(),
  userId: text("user_id").notNull(),
}).as(sql`
  SELECT oidc_client_access_teams.client_id, team_membership.user_id
  FROM oidc_client_access_teams
  INNER JOIN team_membership ON team_membership.team_id = oidc_client_access_teams.team_id
  INNER JOIN users ON users.id = team_membership.user_id AND users.status = 'active'
  UNION
  SELECT oidc_clients.id, users.id
  FROM oidc_clients
  INNER JOIN users ON users.status = 'active'
  WHERE oidc_clients.registration <> 'admin'
`);

/** Who may sign in to each SAML application: active members of its access teams. */
export const samlApplicationAccess = sqliteView("saml_application_access", {
  applicationId: text("application_id").notNull(),
  userId: text("user_id").notNull(),
}).as(sql`
  SELECT DISTINCT saml_application_access_teams.application_id, team_membership.user_id
  FROM saml_application_access_teams
  INNER JOIN team_membership ON team_membership.team_id = saml_application_access_teams.team_id
  INNER JOIN users ON users.id = team_membership.user_id AND users.status = 'active'
`);

/**
 * SCIM 2.0 provisioning from this workspace into one SSO application: its
 * people and the teams it may see are created, updated, and deactivated there.
 */
export const scimConnections = sqliteTable(
  "scim_connections",
  {
    id: text("id").primaryKey(),
    oidcClientId: text("oidc_client_id").references(() => oidcClients.id, {
      onDelete: "cascade",
    }),
    samlApplicationId: text("saml_application_id").references(
      () => samlApplications.id,
      { onDelete: "cascade" }
    ),
    /** The application's SCIM base URL, without /Users or /Groups. */
    baseUrl: text("base_url").notNull(),
    // Sync sends it as a bearer token; it is never returned after it is set.
    token: text("token").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Keeps two syncs of one connection from running at once. */
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    /** A sync that started before this runs again when it finishes. */
    syncRequestedAt: integer("sync_requested_at", { mode: "timestamp_ms" }),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("scim_connections_oidc_client_unique").on(table.oidcClientId),
    uniqueIndex("scim_connections_saml_application_unique").on(
      table.samlApplicationId
    ),
  ]
);

/** What a SCIM connection has created in the application, and as what. */
export const scimResources = sqliteTable(
  "scim_resources",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => scimConnections.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["user", "group"] }).notNull(),
    /** A user or team id; the row outlives them so the remote copy can be removed. */
    localId: text("local_id").notNull(),
    remoteId: text("remote_id").notNull(),
    /** Hash of the last payload the application accepted. */
    hash: text("hash").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.kind, table.localId] }),
  ]
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
      table.spRequestId
    ),
    index("saml_authn_requests_expiry_idx").on(table.expiresAt),
    index("saml_authn_requests_user_idx").on(table.userId),
    index("saml_authn_requests_status_idx").on(table.status),
  ]
);

export const oidcAuthorizationRequests = sqliteTable(
  "oidc_authorization_requests",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oidcClients.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
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
    /** RFC 8707: the resource (MCP or JMAP endpoint) the token is for; null for sign-in only. */
    resource: text("resource"),
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
  ]
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
    /** RFC 8707: the resource (MCP or JMAP endpoint) the token is for; null for sign-in only. */
    resource: text("resource"),
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
      table.clientId
    ),
  ]
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
  ]
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
    /** RFC 8707: the resource (MCP or JMAP endpoint) the token is for; null for sign-in only. */
    resource: text("resource"),
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
      table.clientId
    ),
  ]
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
    /** RFC 8707: the resource (MCP or JMAP endpoint) the token is for; null for sign-in only. */
    resource: text("resource"),
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
      table.clientId
    ),
  ]
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
    detail: text("detail", { mode: "json" }).$type<OidcAuditDetail>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("oidc_audit_events_created_idx").on(table.createdAt),
    index("oidc_audit_events_client_idx").on(table.clientId),
  ]
);

export type User = typeof users.$inferSelect;

export type Mailbox = typeof mailboxes.$inferSelect;
