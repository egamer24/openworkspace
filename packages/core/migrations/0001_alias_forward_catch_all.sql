ALTER TABLE `mailboxes` ADD `alias_of` text REFERENCES mailboxes(id);--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `forward_to` text;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `catch_all` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `mailboxes_alias_of_idx` ON `mailboxes` (`alias_of`);--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_catch_all_unique` ON `mailboxes` (`domain`) WHERE "mailboxes"."catch_all" = 1;--> statement-breakpoint
DROP VIEW `mailbox_access`;--> statement-breakpoint
CREATE VIEW `mailbox_access` AS 
  SELECT id AS mailbox_id, owner_user_id AS user_id, 1 AS can_send
  FROM mailboxes
  WHERE owner_user_id IS NOT NULL AND delivery = 'inbox'
  UNION ALL
  SELECT mailboxes.id, team_membership.user_id, team_membership.can_send
  FROM mailboxes
  INNER JOIN team_membership ON team_membership.team_id = mailboxes.team_id
  WHERE mailboxes.delivery = 'inbox'
;