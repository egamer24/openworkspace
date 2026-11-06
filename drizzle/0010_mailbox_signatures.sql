CREATE TABLE `mailbox_signatures` (
	`mailbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`text` text NOT NULL,
	`use_on_new` integer DEFAULT true NOT NULL,
	`use_on_reply` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`mailbox_id`, `user_id`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_signatures_user_idx` ON `mailbox_signatures` (`user_id`);