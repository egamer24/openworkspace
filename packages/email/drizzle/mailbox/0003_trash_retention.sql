ALTER TABLE `conversations` ADD `state_changed_at` integer;--> statement-breakpoint
CREATE INDEX `conversations_state_changed_idx` ON `conversations` (`mailbox_state`,`state_changed_at`);--> statement-breakpoint
-- Trash and Spam already here start their clock at the upgrade, so the Spam
-- default never deletes old mail at once.
UPDATE `conversations` SET `state_changed_at` = (unixepoch() * 1000)
WHERE `mailbox_state` IN ('trash', 'spam');
