CREATE TABLE `calendars` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`feed_token` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`calendar_id` text NOT NULL,
	`uid` text NOT NULL,
	`recurrence_id` integer,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`time_zone` text NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`transparency` text DEFAULT 'busy' NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`rrule` text,
	`exdates` text DEFAULT '[]' NOT NULL,
	`reminders` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`calendar_id`) REFERENCES `calendars`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_master_uid_unique` ON `events` (`uid`) WHERE "events"."recurrence_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `events_override_unique` ON `events` (`uid`,`recurrence_id`);--> statement-breakpoint
CREATE INDEX `events_calendar_start_idx` ON `events` (`calendar_id`,`starts_at`);