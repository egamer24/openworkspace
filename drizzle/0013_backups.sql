CREATE TABLE `backup_objects` (
	`sha256` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`last_run_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backup_objects_last_run_idx` ON `backup_objects` (`last_run_id`);--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`mailbox_id` text,
	`mailbox_address` text,
	`email_cursor` text,
	`part` integer DEFAULT 0 NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`byte_count` integer DEFAULT 0 NOT NULL,
	`new_object_count` integer DEFAULT 0 NOT NULL,
	`errors_json` text DEFAULT '[]' NOT NULL,
	`lease_until` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
