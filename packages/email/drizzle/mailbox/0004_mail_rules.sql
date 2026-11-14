CREATE TABLE `mail_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`match` text NOT NULL,
	`conditions_json` text NOT NULL,
	`actions_json` text NOT NULL,
	`stop_processing` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_rules_position_idx` ON `mail_rules` (`position`);