CREATE TABLE `drive_items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`content_type` text,
	`r2_key` text,
	`created_by_user_id` text NOT NULL,
	`trashed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_id`) REFERENCES `drive_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drive_items_root_name_unique` ON `drive_items` (`owner_user_id`,lower("name")) WHERE "drive_items"."parent_id" IS NULL AND "drive_items"."trashed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `drive_items_child_name_unique` ON `drive_items` (`parent_id`,lower("name")) WHERE "drive_items"."parent_id" IS NOT NULL AND "drive_items"."trashed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `drive_items_parent_idx` ON `drive_items` (`parent_id`);--> statement-breakpoint
CREATE INDEX `drive_items_owner_idx` ON `drive_items` (`owner_user_id`,`trashed_at`);--> statement-breakpoint
CREATE TABLE `drive_links` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`access` text NOT NULL,
	`password_hash` text,
	`expires_at` integer,
	`access_count` integer DEFAULT 0 NOT NULL,
	`last_accessed_at` integer,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `drive_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drive_links_token_hash_unique` ON `drive_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `drive_links_item_idx` ON `drive_links` (`item_id`);--> statement-breakpoint
CREATE TABLE `drive_quotas` (
	`user_id` text PRIMARY KEY NOT NULL,
	`quota_bytes` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `drive_shares` (
	`item_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`item_id`, `user_id`),
	FOREIGN KEY (`item_id`) REFERENCES `drive_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `drive_shares_user_idx` ON `drive_shares` (`user_id`);