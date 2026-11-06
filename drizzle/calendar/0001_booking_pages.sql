CREATE TABLE `booking_types` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`duration_minutes` integer NOT NULL,
	`time_zone` text NOT NULL,
	`weekly_hours` text DEFAULT '[]' NOT NULL,
	`date_overrides` text DEFAULT '[]' NOT NULL,
	`buffer_before_minutes` integer DEFAULT 0 NOT NULL,
	`buffer_after_minutes` integer DEFAULT 0 NOT NULL,
	`minimum_notice_minutes` integer DEFAULT 0 NOT NULL,
	`max_days_ahead` integer DEFAULT 60 NOT NULL,
	`slot_interval_minutes` integer NOT NULL,
	`daily_cap` integer,
	`collect_notes` integer DEFAULT true NOT NULL,
	`calendar_id` text,
	`sender_mailbox_id` text,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_types_slug_unique` ON `booking_types` (`slug`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_type_id` text NOT NULL,
	`event_id` text NOT NULL,
	`guest_name` text NOT NULL,
	`guest_email` text NOT NULL,
	`guest_time_zone` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`booking_type_id`) REFERENCES `booking_types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bookings_type_start_idx` ON `bookings` (`booking_type_id`,`starts_at`);