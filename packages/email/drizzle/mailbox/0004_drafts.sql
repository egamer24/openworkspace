CREATE TABLE `drafts` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`source_email_id` text,
	`conversation_id` text,
	`reply_mode` text,
	`to_json` text NOT NULL,
	`cc_json` text NOT NULL,
	`bcc_json` text NOT NULL,
	`reply_to` text,
	`subject` text NOT NULL,
	`body_text` text NOT NULL,
	`body_html` text,
	`editor_html` text,
	`attachments_json` text DEFAULT '[]' NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `drafts_user_updated_idx` ON `drafts` (`user_id`,`updated_at`);