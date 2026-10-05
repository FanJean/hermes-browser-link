DROP INDEX `idx_commands_request`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_commands_request` ON `commands` (`owner_id`,`device_id`,`session_id`,`request_key`);