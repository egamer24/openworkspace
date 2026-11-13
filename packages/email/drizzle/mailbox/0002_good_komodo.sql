ALTER TABLE `emails` ADD `split_from_conversation_id` text;--> statement-breakpoint
ALTER TABLE `pending_inbound` ADD `unfinished_attempts` integer DEFAULT 0 NOT NULL;