CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`model` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_messages_role_check" CHECK("conversation_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "conversation_messages_status_check" CHECK("conversation_messages"."status" in ('complete', 'cancelled', 'error')),
	CONSTRAINT "conversation_messages_seq_check" CHECK("conversation_messages"."seq" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_messages_seq_uq` ON `conversation_messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_updated_idx` ON `conversations` (`updated_at`);