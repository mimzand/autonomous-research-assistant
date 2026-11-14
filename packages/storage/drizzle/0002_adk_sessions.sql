CREATE TABLE `adk_app_state` (
	`app_name` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `adk_events` (
	`app_name` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`seq` integer NOT NULL,
	`invocation_id` text NOT NULL,
	`author` text,
	`timestamp_ms` integer NOT NULL,
	`event` text NOT NULL,
	`byte_length` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`app_name`, `user_id`, `session_id`, `id`),
	FOREIGN KEY (`app_name`,`user_id`,`session_id`) REFERENCES `adk_sessions`(`app_name`,`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "adk_events_seq_check" CHECK("adk_events"."seq" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `adk_events_session_seq_uq` ON `adk_events` (`app_name`,`user_id`,`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `adk_events_invocation_idx` ON `adk_events` (`app_name`,`user_id`,`session_id`,`invocation_id`);--> statement-breakpoint
CREATE TABLE `adk_sessions` (
	`app_name` text NOT NULL,
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`state` text NOT NULL,
	`update_time_ms` integer NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`app_name`, `user_id`, `id`),
	CONSTRAINT "adk_sessions_event_count_check" CHECK("adk_sessions"."event_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `adk_sessions_user_update_idx` ON `adk_sessions` (`app_name`,`user_id`,`update_time_ms`);--> statement-breakpoint
CREATE TABLE `adk_user_state` (
	`app_name` text NOT NULL,
	`user_id` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`app_name`, `user_id`)
);
