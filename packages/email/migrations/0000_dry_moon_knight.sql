CREATE TABLE `blocked_senders` (
	`pattern` text PRIMARY KEY NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `jmap_push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`device_client_id` text NOT NULL,
	`url` text NOT NULL,
	`p256dh` text,
	`auth` text,
	`verification_code` text NOT NULL,
	`verified_at` integer,
	`expires_at` integer NOT NULL,
	`types_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`,`user_id`) REFERENCES `oidc_grants`(`client_id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jmap_push_subscriptions_device_unique` ON `jmap_push_subscriptions` (`user_id`,`device_client_id`);--> statement-breakpoint
CREATE INDEX `jmap_push_subscriptions_expires_idx` ON `jmap_push_subscriptions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `mailbox_counts` (
	`mailbox_id` text PRIMARY KEY NOT NULL,
	`incoming_count` integer NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mailbox_notification_preferences` (
	`mailbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`mailbox_id`, `user_id`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_notification_preferences_user_idx` ON `mailbox_notification_preferences` (`user_id`);--> statement-breakpoint
CREATE TABLE `mailbox_read_counts` (
	`mailbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`read_count` integer NOT NULL,
	PRIMARY KEY(`mailbox_id`, `user_id`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `sender_reports` (
	`mailbox_id` text NOT NULL,
	`email_id` text NOT NULL,
	`address` text NOT NULL,
	`domain` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`mailbox_id`, `email_id`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sender_reports_domain_idx` ON `sender_reports` (`domain`,`address`);