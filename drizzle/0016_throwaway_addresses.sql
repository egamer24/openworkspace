ALTER TABLE `routing_addresses` ADD `throwaway` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `routing_addresses` ADD `label` text;--> statement-breakpoint
ALTER TABLE `routing_addresses` ADD `disabled_at` integer;--> statement-breakpoint
CREATE INDEX `routing_addresses_creator_idx` ON `routing_addresses` (`created_by_user_id`);