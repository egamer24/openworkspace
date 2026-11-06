CREATE TABLE `retention_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`trash_days` integer,
	`spam_days` integer,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `state_changed_at` integer;--> statement-breakpoint
CREATE INDEX `conversations_state_changed_idx` ON `conversations` (`mailbox_state`,`state_changed_at`);--> statement-breakpoint
-- Existing Trash and Spam start their retention clock at deploy time, so
-- enabling retention never deletes old mail immediately.
UPDATE `conversations` SET `state_changed_at` = (unixepoch() * 1000)
WHERE `mailbox_state` IN ('trash', 'spam');--> statement-breakpoint
-- Covers every path that changes state, including the emails_after_insert
-- upsert that reactivates archived or trashed threads.
CREATE TRIGGER `conversations_state_changed_at`
AFTER UPDATE OF `mailbox_state` ON `conversations`
FOR EACH ROW
WHEN NEW.`mailbox_state` IS NOT OLD.`mailbox_state`
BEGIN
	UPDATE `conversations` SET `state_changed_at` = (unixepoch() * 1000)
	WHERE `id` = NEW.`id`;
END;
