CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`latest_email_id` text NOT NULL,
	`timeline_at` integer NOT NULL,
	`mailbox_state` text DEFAULT 'active' NOT NULL,
	`folder_id` text,
	`has_incoming` integer DEFAULT false NOT NULL,
	`has_outgoing` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`latest_email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `conversations_timeline_idx` ON `conversations` (`timeline_at`,`latest_email_id`);--> statement-breakpoint
CREATE INDEX `conversations_inbox_timeline_idx` ON `conversations` (`mailbox_state`,`has_incoming`,`timeline_at`,`latest_email_id`);--> statement-breakpoint
CREATE INDEX `conversations_sent_timeline_idx` ON `conversations` (`mailbox_state`,`has_outgoing`,`timeline_at`,`latest_email_id`);--> statement-breakpoint
CREATE INDEX `conversations_folder_timeline_idx` ON `conversations` (`folder_id`,`timeline_at`,`latest_email_id`);--> statement-breakpoint
CREATE TABLE `email_read_states` (
	`user_id` text NOT NULL,
	`email_id` text NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `email_id`),
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_read_states_email_idx` ON `email_read_states` (`email_id`);--> statement-breakpoint
CREATE TABLE `emails` (
	`id` text PRIMARY KEY NOT NULL,
	`request_fingerprint` text,
	`conversation_id` text NOT NULL,
	`direction` text NOT NULL,
	`message_id_header` text,
	`in_reply_to_json` text DEFAULT '[]' NOT NULL,
	`references_json` text DEFAULT '[]' NOT NULL,
	`from_json` text NOT NULL,
	`reply_to_json` text DEFAULT '[]' NOT NULL,
	`to_json` text DEFAULT '[]' NOT NULL,
	`cc_json` text DEFAULT '[]' NOT NULL,
	`bcc_json` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT '(no subject)' NOT NULL,
	`preview` text DEFAULT '' NOT NULL,
	`body_text` text,
	`quoted_text` text,
	`body_html_r2_key` text,
	`raw_mime_r2_key` text,
	`authentication_results_json` text,
	`envelope_from` text,
	`envelope_to` text,
	`list_unsubscribe_json` text,
	`sender_intel_json` text,
	`ai_classification_json` text,
	`delivery_json` text,
	`screening_json` text,
	`report_label` text,
	`attachments_json` text DEFAULT '[]' NOT NULL,
	`list_id` text,
	`list_post_address` text,
	`timeline_at` integer NOT NULL,
	`transport_state` text NOT NULL,
	`transport_error` text,
	`delivery_status_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `emails_conversation_timeline_idx` ON `emails` (`conversation_id`,`timeline_at`,`id`);--> statement-breakpoint
CREATE INDEX `emails_message_id_header_idx` ON `emails` (`message_id_header`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 100 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folders_name_unique` ON `folders` (`name`);--> statement-breakpoint
CREATE INDEX `folders_order_idx` ON `folders` (`sort_order`,`name`);--> statement-breakpoint
CREATE TABLE `mailbox_ai_configuration` (
	`id` text PRIMARY KEY NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`confidence_threshold` integer DEFAULT 75 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pending_inbound` (
	`id` text PRIMARY KEY NOT NULL,
	`raw_object_key` text NOT NULL,
	`envelope_from` text NOT NULL,
	`envelope_to` text NOT NULL,
	`list_address` text,
	`received_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`ai_attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_inbound_next_attempt_idx` ON `pending_inbound` (`next_attempt_at`,`received_at`);--> statement-breakpoint
CREATE TABLE `pending_object_deletions` (
	`object_key` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_object_deletions_next_attempt_idx` ON `pending_object_deletions` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `pending_office_previews` (
	`source_key` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_office_previews_next_attempt_idx` ON `pending_office_previews` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `sender_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`domain` text NOT NULL,
	`email_id` text,
	`label` text NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sender_feedback_address_idx` ON `sender_feedback` (`address`,`created_at`);--> statement-breakpoint
CREATE INDEX `sender_feedback_domain_idx` ON `sender_feedback` (`domain`);--> statement-breakpoint
CREATE TABLE `senders` (
	`address` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`first_seen_at` integer,
	`last_seen_at` integer,
	`message_count` integer DEFAULT 0 NOT NULL,
	`outbound_count` integer DEFAULT 0 NOT NULL,
	`last_outbound_at` integer,
	`blocked_at` integer,
	`trusted_at` integer,
	`reported_at` integer
);
--> statement-breakpoint
CREATE INDEX `senders_domain_idx` ON `senders` (`domain`);--> statement-breakpoint
CREATE TABLE `system_folder_order` (
	`folder_id` text PRIMARY KEY NOT NULL,
	`sort_order` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `unsubscriptions` (
	`list_key` text PRIMARY KEY NOT NULL,
	`email_id` text,
	`method` text NOT NULL,
	`status` text NOT NULL,
	`target` text,
	`detail` text,
	`user_id` text,
	`created_at` integer NOT NULL
);
