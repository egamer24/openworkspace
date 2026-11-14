CREATE TABLE `signatures` (
	`user_id` text,
	`mailbox_id` text,
	`html` text NOT NULL,
	`text` text NOT NULL,
	`images` text NOT NULL,
	`use_on_new` integer DEFAULT true NOT NULL,
	`use_on_reply` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "signatures_one_owner" CHECK(("signatures"."user_id" is null) <> ("signatures"."mailbox_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signatures_user_idx` ON `signatures` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `signatures_mailbox_idx` ON `signatures` (`mailbox_id`);