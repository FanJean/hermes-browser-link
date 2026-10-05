ALTER TABLE `commands` ADD `response_digest` text;--> statement-breakpoint
ALTER TABLE `commands` ADD `result_delivered` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `browser_connected` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `full_access` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `access_scope` text DEFAULT 'selected_sites' NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `browser` text DEFAULT 'chrome' NOT NULL;