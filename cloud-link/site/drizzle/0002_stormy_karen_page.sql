ALTER TABLE `sessions` ADD `state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_seen` integer DEFAULT 0 NOT NULL;