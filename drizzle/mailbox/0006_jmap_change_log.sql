CREATE TABLE `jmap_change_floor` (
	`id` integer PRIMARY KEY NOT NULL,
	`floor` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jmap_changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`object_id` text NOT NULL,
	`kind` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jmap_changes_type_seq_idx` ON `jmap_changes` (`type`,`seq`);--> statement-breakpoint
-- Runtime-only change tracking triggers: Drizzle snapshots do not model them.
-- Existing rows predate the log; floor 0 is still correct because clients can
-- only hold states issued after this migration.
INSERT INTO `jmap_change_floor` (`id`, `floor`) VALUES (1, 0);--> statement-breakpoint
CREATE TRIGGER `jmap_changes_prune`
AFTER INSERT ON `jmap_changes`
WHEN NEW.`seq` % 1000 = 0
BEGIN
	DELETE FROM `jmap_changes` WHERE `seq` <= NEW.`seq` - 50000;
	UPDATE `jmap_change_floor` SET `floor` = MAX(`floor`, NEW.`seq` - 50000) WHERE `id` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `jmap_emails_insert`
AFTER INSERT ON `emails`
BEGIN
	INSERT INTO `jmap_changes` (`type`, `object_id`, `kind`) VALUES
		('Email', NEW.`id`, 'created'),
		('Thread', NEW.`conversation_id`, 'updated');
END;--> statement-breakpoint
CREATE TRIGGER `jmap_emails_update`
AFTER UPDATE ON `emails`
BEGIN
	INSERT INTO `jmap_changes` (`type`, `object_id`, `kind`) VALUES ('Email', NEW.`id`, 'updated');
END;--> statement-breakpoint
CREATE TRIGGER `jmap_emails_delete`
AFTER DELETE ON `emails`
BEGIN
	INSERT INTO `jmap_changes` (`type`, `object_id`, `kind`) VALUES
		('Email', OLD.`id`, 'destroyed'),
		('Thread', OLD.`conversation_id`, 'updated');
END;--> statement-breakpoint
CREATE TRIGGER `jmap_conversations_insert`
AFTER INSERT ON `conversations`
BEGIN
	INSERT INTO `jmap_changes` (`type`, `object_id`, `kind`) VALUES ('Thread', NEW.`id`, 'created');
END;--> statement-breakpoint
CREATE TRIGGER `jmap_conversations_update`
AFTER UPDATE ON `conversations`
WHEN OLD.`mailbox_state` IS NOT NEW.`mailbox_state`
	OR OLD.`folder_id` IS NOT NEW.`folder_id`
	OR OLD.`has_incoming` IS NOT NEW.`has_incoming`
BEGIN
	-- mailboxIds are derived from conversation state, so every message moves.
	INSERT INTO `jmap_changes` (`type`, `object_id`, `kind`)
	SELECT 'Email', `id`, 'updated' FROM `emails` WHERE `conversation_id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `jmap_conversations_delete`
AFTER DELETE ON `conversations`
BEGIN
	INSERT INTO `jmap_changes` (`type`, `object_id`, `kind`) VALUES ('Thread', OLD.`id`, 'destroyed');
END;--> statement-breakpoint
CREATE TRIGGER `jmap_read_states_insert`
AFTER INSERT ON `email_read_states`
BEGIN
	INSERT INTO `jmap_changes` (`type`, `object_id`, `kind`) VALUES ('Email', NEW.`email_id`, 'updated');
END;--> statement-breakpoint
CREATE TRIGGER `jmap_read_states_delete`
AFTER DELETE ON `email_read_states`
BEGIN
	INSERT INTO `jmap_changes` (`type`, `object_id`, `kind`) VALUES ('Email', OLD.`email_id`, 'updated');
END;--> statement-breakpoint
CREATE TRIGGER `jmap_folders_insert`
AFTER INSERT ON `folders`
BEGIN
	INSERT INTO `jmap_changes` (`type`, `object_id`, `kind`) VALUES ('Mailbox', NEW.`id`, 'created');
END;--> statement-breakpoint
CREATE TRIGGER `jmap_folders_update`
AFTER UPDATE ON `folders`
BEGIN
	INSERT INTO `jmap_changes` (`type`, `object_id`, `kind`) VALUES ('Mailbox', NEW.`id`, 'updated');
END;--> statement-breakpoint
CREATE TRIGGER `jmap_folders_delete`
AFTER DELETE ON `folders`
BEGIN
	INSERT INTO `jmap_changes` (`type`, `object_id`, `kind`) VALUES ('Mailbox', OLD.`id`, 'destroyed');
END;
