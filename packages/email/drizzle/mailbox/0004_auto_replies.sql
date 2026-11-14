CREATE TABLE `auto_reply_log` (
	`sender_address` text PRIMARY KEY NOT NULL,
	`last_replied_at` integer NOT NULL,
	`last_original_email_id` text NOT NULL,
	`last_outbound_message_id` text
);
--> statement-breakpoint
CREATE INDEX `auto_reply_log_replied_idx` ON `auto_reply_log` (`last_replied_at`);--> statement-breakpoint
CREATE TABLE `auto_reply_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`reply_interval_days` integer NOT NULL,
	`inside` text NOT NULL,
	`outside` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
