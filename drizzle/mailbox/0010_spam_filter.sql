CREATE TABLE `spam_filter_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`spam_threshold` integer NOT NULL,
	`suspicious_threshold` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spam_sender_rules` (
	`entry` text PRIMARY KEY NOT NULL,
	`list` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `emails` ADD `spam_score` integer;--> statement-breakpoint
ALTER TABLE `emails` ADD `spam_verdict` text;--> statement-breakpoint
ALTER TABLE `emails` ADD `spam_reasons_json` text;--> statement-breakpoint
CREATE TABLE `spam_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`spam_count` integer DEFAULT 0 NOT NULL,
	`ham_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spam_training` (
	`email_id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`tokens_json` text NOT NULL,
	`trained_at` integer NOT NULL
);
