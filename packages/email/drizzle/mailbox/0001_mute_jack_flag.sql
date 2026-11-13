-- The search index, which the drizzle schema cannot express. A custom
-- migration (drizzle-kit generate --custom): later generates leave it as it
-- is. The mailbox fills it in the transaction that inserts each email
-- (worker/mailbox/email-index.ts).
CREATE VIRTUAL TABLE `email_search` USING fts5(
	`email_id` UNINDEXED,
	`conversation_id` UNINDEXED,
	`subject`,
	`addresses`,
	`body`,
	tokenize = 'unicode61 remove_diacritics 2'
);
