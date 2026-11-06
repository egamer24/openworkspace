CREATE TABLE `domain_onboarding_steps` (
	`domain_id` text NOT NULL,
	`step` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`domain_id`, `step`),
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `forwarding_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`cloudflare_id` text,
	`verified_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forwarding_destinations_email_unique` ON `forwarding_destinations` (`email`);--> statement-breakpoint
CREATE TABLE `routing_address_destinations` (
	`address_id` text NOT NULL,
	`destination_id` text NOT NULL,
	PRIMARY KEY(`address_id`, `destination_id`),
	FOREIGN KEY (`address_id`) REFERENCES `routing_addresses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `forwarding_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routing_address_destinations_destination_idx` ON `routing_address_destinations` (`destination_id`);--> statement-breakpoint
CREATE TABLE `routing_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`local_part` text NOT NULL,
	`mailbox_id` text,
	`keep_copy` integer DEFAULT true NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routing_addresses_address_unique` ON `routing_addresses` (`domain_id`,`local_part`);--> statement-breakpoint
CREATE INDEX `routing_addresses_mailbox_idx` ON `routing_addresses` (`mailbox_id`);--> statement-breakpoint
ALTER TABLE `domains` ADD `unknown_recipient_mailbox_id` text REFERENCES mailboxes(id) ON DELETE SET NULL;