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
