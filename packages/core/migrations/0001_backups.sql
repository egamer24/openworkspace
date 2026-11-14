CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`module` text,
	`cursor` text,
	`part` integer DEFAULT 0 NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`new_object_count` integer DEFAULT 0 NOT NULL,
	`new_object_bytes` integer DEFAULT 0 NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`swept` integer DEFAULT false NOT NULL,
	`lease_until` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
