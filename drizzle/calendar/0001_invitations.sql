ALTER TABLE `events` ADD `organizer` text;--> statement-breakpoint
ALTER TABLE `events` ADD `attendees` text DEFAULT '[]' NOT NULL;