CREATE TABLE `domain_onboarding_steps` (
	`domain_id` text NOT NULL,
	`step` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`domain_id`, `step`),
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
