-- 中文注释：为云端设备、会话和请求队列创建独立表。
CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`device_id` text NOT NULL,
	`session_id` text NOT NULL,
	`request_key` text NOT NULL,
	`digest` text NOT NULL,
	`tool` text NOT NULL,
	`args` text NOT NULL,
	`state` text NOT NULL,
	`result` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`result_expires_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_commands_request` ON `commands` (`owner_id`,`device_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `idx_commands_queue` ON `commands` (`device_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`token_hash` text NOT NULL,
	`code_hash` text,
	`instance_id` text NOT NULL,
	`label` text NOT NULL,
	`origins` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_devices_token` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_devices_code` ON `devices` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_devices_owner` ON `devices` (`owner_id`,`state`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`device_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
