CREATE TABLE `access_link_claims` (
	`access_link_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`claimed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`access_link_id`) REFERENCES `access_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `access_links` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_links_token_hash_unique` ON `access_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `access_links_user_kind_idx` ON `access_links` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `access_links_expiry_idx` ON `access_links` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`access_link_id` text,
	`rp_id` text NOT NULL,
	`origin` text NOT NULL,
	`payload` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`access_link_id`) REFERENCES `access_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_challenges_expiry_idx` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `auth_challenges_user_idx` ON `auth_challenges` (`user_id`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`local_part` text NOT NULL,
	`domain` text NOT NULL,
	`display_name` text NOT NULL,
	`owner_user_id` text,
	`team_id` text,
	`delivery` text DEFAULT 'inbox' NOT NULL,
	`list_posting` text DEFAULT 'workspace' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "mailboxes_primary_owner_check" CHECK("mailboxes"."is_primary" = 0 OR "mailboxes"."owner_user_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_address_unique` ON `mailboxes` (`domain`,`local_part`);--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_owner_primary_unique` ON `mailboxes` (`owner_user_id`) WHERE "mailboxes"."is_primary" = 1;--> statement-breakpoint
CREATE INDEX `mailboxes_owner_idx` ON `mailboxes` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `mailboxes_team_idx` ON `mailboxes` (`team_id`);--> statement-breakpoint
CREATE TABLE `oidc_access_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text,
	`auth_time` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_access_tokens_expiry_idx` ON `oidc_access_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oidc_access_tokens_family_idx` ON `oidc_access_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `oidc_access_tokens_user_client_idx` ON `oidc_access_tokens` (`user_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `oidc_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`actor_user_id` text,
	`subject_user_id` text,
	`client_id` text,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`subject_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `oidc_audit_events_created_idx` ON `oidc_audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `oidc_audit_events_client_idx` ON `oidc_audit_events` (`client_id`);--> statement-breakpoint
CREATE TABLE `oidc_authorization_codes` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text,
	`nonce` text,
	`code_challenge` text NOT NULL,
	`auth_time` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`issued_access_token_hash` text,
	`issued_refresh_family_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_authorization_codes_expiry_idx` ON `oidc_authorization_codes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oidc_authorization_codes_user_client_idx` ON `oidc_authorization_codes` (`user_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `oidc_authorization_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`status` text DEFAULT 'awaiting_consent' NOT NULL,
	`browser_secret_hash` text,
	`force_consent` integer DEFAULT false NOT NULL,
	`redirect_uri` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text,
	`state` text,
	`nonce` text,
	`code_challenge` text NOT NULL,
	`auth_time` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_authorization_requests_expiry_idx` ON `oidc_authorization_requests` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oidc_authorization_requests_user_idx` ON `oidc_authorization_requests` (`user_id`);--> statement-breakpoint
CREATE INDEX `oidc_authorization_requests_status_idx` ON `oidc_authorization_requests` (`status`);--> statement-breakpoint
CREATE TABLE `oidc_client_access_teams` (
	`client_id` text NOT NULL,
	`team_id` text NOT NULL,
	`sent_as` text,
	PRIMARY KEY(`client_id`, `team_id`),
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_client_access_teams_team_idx` ON `oidc_client_access_teams` (`team_id`);--> statement-breakpoint
CREATE TABLE `oidc_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`client_type` text NOT NULL,
	`secret_hash` text,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text DEFAULT '[]' NOT NULL,
	`backchannel_logout_uri` text,
	`allowed_origins` text DEFAULT '[]' NOT NULL,
	`allowed_scopes` text NOT NULL,
	`trusted` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`registration` text DEFAULT 'admin' NOT NULL,
	`metadata_fetched_at` integer,
	`require_pkce` integer DEFAULT true NOT NULL,
	`managed_by` text,
	`created_by_user_id` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `oidc_clients_enabled_idx` ON `oidc_clients` (`enabled`);--> statement-breakpoint
CREATE INDEX `oidc_clients_created_by_idx` ON `oidc_clients` (`created_by_user_id`);--> statement-breakpoint
CREATE TABLE `oidc_grants` (
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`granted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`client_id`, `user_id`),
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_grants_user_idx` ON `oidc_grants` (`user_id`);--> statement-breakpoint
CREATE TABLE `oidc_refresh_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text,
	`auth_time` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`replaced_by_token_hash` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oidc_refresh_tokens_family_idx` ON `oidc_refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `oidc_refresh_tokens_expiry_idx` ON `oidc_refresh_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `oidc_refresh_tokens_user_client_idx` ON `oidc_refresh_tokens` (`user_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `passkey_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`device_type` text NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_credentials_user_idx` ON `passkey_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `saml_application_access_teams` (
	`application_id` text NOT NULL,
	`team_id` text NOT NULL,
	`sent_as` text,
	PRIMARY KEY(`application_id`, `team_id`),
	FOREIGN KEY (`application_id`) REFERENCES `saml_applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saml_application_access_teams_team_idx` ON `saml_application_access_teams` (`team_id`);--> statement-breakpoint
CREATE TABLE `saml_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`entity_id` text NOT NULL,
	`acs_url` text NOT NULL,
	`name_id_format` text DEFAULT 'email' NOT NULL,
	`email_attribute_name` text NOT NULL,
	`name_attribute_name` text NOT NULL,
	`groups_attribute_name` text,
	`sign_response` integer DEFAULT true NOT NULL,
	`require_signed_authn_requests` integer DEFAULT false NOT NULL,
	`sp_signing_certificate` text,
	`allow_idp_initiated` integer DEFAULT true NOT NULL,
	`first_name_attribute_name` text,
	`last_name_attribute_name` text,
	`managed_by` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by_user_id` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_applications_entity_id_unique` ON `saml_applications` (`entity_id`);--> statement-breakpoint
CREATE INDEX `saml_applications_enabled_idx` ON `saml_applications` (`enabled`);--> statement-breakpoint
CREATE INDEX `saml_applications_created_by_idx` ON `saml_applications` (`created_by_user_id`);--> statement-breakpoint
CREATE TABLE `saml_authn_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`user_id` text,
	`sp_request_id` text,
	`acs_url` text NOT NULL,
	`relay_state` text,
	`requested_sp_name_qualifier` text,
	`allow_name_id_creation` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'awaiting_login' NOT NULL,
	`browser_secret_hash` text,
	`auth_time` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `saml_applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_authn_requests_sp_request_unique` ON `saml_authn_requests` (`application_id`,`sp_request_id`);--> statement-breakpoint
CREATE INDEX `saml_authn_requests_expiry_idx` ON `saml_authn_requests` (`expires_at`);--> statement-breakpoint
CREATE INDEX `saml_authn_requests_user_idx` ON `saml_authn_requests` (`user_id`);--> statement-breakpoint
CREATE INDEX `saml_authn_requests_status_idx` ON `saml_authn_requests` (`status`);--> statement-breakpoint
CREATE TABLE `saml_pairwise_subjects` (
	`application_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`application_id`, `user_id`),
	FOREIGN KEY (`application_id`) REFERENCES `saml_applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_pairwise_subjects_name_id_unique` ON `saml_pairwise_subjects` (`name_id`);--> statement-breakpoint
CREATE INDEX `saml_pairwise_subjects_user_idx` ON `saml_pairwise_subjects` (`user_id`);--> statement-breakpoint
CREATE TABLE `scim_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`oidc_client_id` text,
	`saml_application_id` text,
	`base_url` text NOT NULL,
	`token` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`lease_until` integer,
	`sync_requested_at` integer,
	`last_sync_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`oidc_client_id`) REFERENCES `oidc_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`saml_application_id`) REFERENCES `saml_applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_connections_oidc_client_unique` ON `scim_connections` (`oidc_client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_connections_saml_application_unique` ON `scim_connections` (`saml_application_id`);--> statement-breakpoint
CREATE TABLE `scim_resources` (
	`connection_id` text NOT NULL,
	`kind` text NOT NULL,
	`local_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`hash` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`connection_id`, `kind`, `local_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `scim_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`user_agent` text,
	`location` text,
	`ip_address` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_created_idx` ON `sessions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`can_send` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_members_user_idx` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`everyone` integer DEFAULT false NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_slug_unique` ON `teams` (`slug`);--> statement-breakpoint
CREATE INDEX `teams_name_idx` ON `teams` (`name`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar_id` text,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`response_status` integer,
	`response_body` text,
	`error` text,
	`last_attempt_at` integer,
	`delivered_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhook_endpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_event_endpoint_unique` ON `webhook_deliveries` (`event_id`,`webhook_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_created_idx` ON `webhook_deliveries` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_created_idx` ON `webhook_deliveries` (`created_at`);--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`mailbox_ids` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`signing_secret` text NOT NULL,
	`managed_by` text,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `webhook_endpoints_enabled_idx` ON `webhook_endpoints` (`enabled`);--> statement-breakpoint
CREATE VIEW `mailbox_access` AS 
  SELECT id AS mailbox_id, owner_user_id AS user_id, 1 AS can_send
  FROM mailboxes
  WHERE owner_user_id IS NOT NULL
  UNION ALL
  SELECT mailboxes.id, team_membership.user_id, team_membership.can_send
  FROM mailboxes
  INNER JOIN team_membership ON team_membership.team_id = mailboxes.team_id
  WHERE mailboxes.delivery = 'inbox'
;--> statement-breakpoint
CREATE VIEW `oidc_client_access` AS 
  SELECT oidc_client_access_teams.client_id, team_membership.user_id
  FROM oidc_client_access_teams
  INNER JOIN team_membership ON team_membership.team_id = oidc_client_access_teams.team_id
  INNER JOIN users ON users.id = team_membership.user_id AND users.status = 'active'
  UNION
  SELECT oidc_clients.id, users.id
  FROM oidc_clients
  INNER JOIN users ON users.status = 'active'
  WHERE oidc_clients.registration <> 'admin'
;--> statement-breakpoint
CREATE VIEW `saml_application_access` AS 
  SELECT DISTINCT saml_application_access_teams.application_id, team_membership.user_id
  FROM saml_application_access_teams
  INNER JOIN team_membership ON team_membership.team_id = saml_application_access_teams.team_id
  INNER JOIN users ON users.id = team_membership.user_id AND users.status = 'active'
;--> statement-breakpoint
CREATE VIEW `team_membership` AS 
  SELECT team_members.team_id, team_members.user_id, team_members.can_send
  FROM team_members
  INNER JOIN teams ON teams.id = team_members.team_id
  WHERE teams.everyone = 0
  UNION ALL
  SELECT teams.id, users.id, 1
  FROM teams
  INNER JOIN users ON users.status = 'active'
  WHERE teams.everyone = 1
;