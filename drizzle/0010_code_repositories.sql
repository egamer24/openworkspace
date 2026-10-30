CREATE TABLE `code_branch_protections` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`pattern` text NOT NULL,
	`push` text NOT NULL,
	`allow_deletion` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `code_repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `code_branch_protections_pattern_unique` ON `code_branch_protections` (`repository_id`,`pattern`);--> statement-breakpoint
CREATE TABLE `code_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`artifacts_name` text NOT NULL,
	`description` text,
	`default_branch` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `code_repositories_name_unique` ON `code_repositories` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `code_repositories_artifacts_name_unique` ON `code_repositories` (`artifacts_name`);