CREATE TABLE `mail_archive_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`direction` text NOT NULL,
	`source_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`archive_key` text NOT NULL,
	`sha256` text,
	`size` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `mail_archive_entries_status_idx` ON `mail_archive_entries` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `mail_archive_entries_source_idx` ON `mail_archive_entries` (`source_key`);--> statement-breakpoint
CREATE INDEX `mail_archive_entries_mailbox_idx` ON `mail_archive_entries` (`mailbox_id`,`status`);