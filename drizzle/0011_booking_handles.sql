CREATE TABLE `booking_handles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_handles_handle_unique` ON `booking_handles` (`handle`);