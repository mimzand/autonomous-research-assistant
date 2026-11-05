CREATE TABLE `task_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`step_id` text,
	`seq` integer NOT NULL,
	`level` text NOT NULL,
	`event` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `task_steps`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "task_logs_level_check" CHECK("task_logs"."level" in ('debug', 'info', 'warn', 'error')),
	CONSTRAINT "task_logs_seq_check" CHECK("task_logs"."seq" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_logs_task_seq_uq` ON `task_logs` (`task_id`,`seq`);--> statement-breakpoint
CREATE INDEX `task_logs_step_idx` ON `task_logs` (`step_id`);