CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`step_id` text,
	`action` text NOT NULL,
	`summary` text NOT NULL,
	`payload` text,
	`status` text NOT NULL,
	`reason` text,
	`decided_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `task_steps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "approvals_status_check" CHECK("approvals"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`);--> statement-breakpoint
CREATE INDEX `approvals_task_idx` ON `approvals` (`task_id`);--> statement-breakpoint
CREATE TABLE `model_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`step_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`purpose` text NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_duration_ms` integer,
	`load_duration_ms` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`step_id`) REFERENCES `task_steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `model_usage_task_idx` ON `model_usage` (`task_id`);--> statement-breakpoint
CREATE INDEX `model_usage_created_at_idx` ON `model_usage` (`created_at`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`format` text NOT NULL,
	`content` text NOT NULL,
	`cited_source_ids` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reports_task_version_uq` ON `reports` (`task_id`,`version`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`is_secret` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_contents` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`content_type` text NOT NULL,
	`text` text NOT NULL,
	`byte_length` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_contents_source_uq` ON `source_contents` (`source_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`retrieved_at` text,
	`metadata` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_task_url_uq` ON `sources` (`task_id`,`url`);--> statement-breakpoint
CREATE TABLE `task_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_steps_status_check" CHECK("task_steps"."status" in ('pending', 'running', 'completed', 'failed', 'interrupted', 'skipped')),
	CONSTRAINT "task_steps_seq_check" CHECK("task_steps"."seq" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_steps_task_seq_uq` ON `task_steps` (`task_id`,`seq`);--> statement-breakpoint
CREATE INDEX `task_steps_status_idx` ON `task_steps` (`status`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`status` text NOT NULL,
	`error` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" in ('pending', 'running', 'awaiting-approval', 'interrupted', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_created_at_idx` ON `tasks` (`created_at`);