-- Tasks move inside repositories (per-repository numbers, required repository).
-- Unreleased task rows from 0011 cannot satisfy the new constraints, so the
-- task tables are recreated.
DROP TABLE IF EXISTS `task_notes`;--> statement-breakpoint
DROP TABLE IF EXISTS `task_attempts`;--> statement-breakpoint
DROP TABLE IF EXISTS `task_dependencies`;--> statement-breakpoint
DROP TABLE IF EXISTS `tasks`;--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`acceptance_criteria` text DEFAULT '' NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`base_branch` text NOT NULL,
	`assignee_user_id` text,
	`created_by_user_id` text NOT NULL,
	`merged_sha` text,
	`merged_at` integer,
	`merged_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `code_repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`merged_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_repository_number_unique` ON `tasks` (`repository_id`,`number`);--> statement-breakpoint
CREATE INDEX `tasks_repository_status_idx` ON `tasks` (`repository_id`,`status`);--> statement-breakpoint
CREATE TABLE `task_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`number` integer NOT NULL,
	`executor_user_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`branch` text NOT NULL,
	`base_sha` text,
	`head_sha` text,
	`summary` text,
	`lease_expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`executor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX `task_attempts_number_unique` ON `task_attempts` (`task_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_attempts_active_unique` ON `task_attempts` (`task_id`) WHERE "task_attempts"."status" = 'active';--> statement-breakpoint
CREATE INDEX `task_attempts_status_idx` ON `task_attempts` (`status`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on_task_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_task_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_dependencies_not_self" CHECK("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);--> statement-breakpoint
CREATE INDEX `task_dependencies_depends_on_idx` ON `task_dependencies` (`depends_on_task_id`);--> statement-breakpoint
CREATE TABLE `task_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX `task_notes_task_idx` ON `task_notes` (`task_id`);--> statement-breakpoint
CREATE TABLE `task_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`verdict` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`head_sha` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `task_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `task_reviews_task_idx` ON `task_reviews` (`task_id`);
