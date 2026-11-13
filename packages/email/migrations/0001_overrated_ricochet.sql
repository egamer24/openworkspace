ALTER TABLE `push_subscriptions` ADD `session_id` text;--> statement-breakpoint
CREATE INDEX `push_subscriptions_session_idx` ON `push_subscriptions` (`session_id`);