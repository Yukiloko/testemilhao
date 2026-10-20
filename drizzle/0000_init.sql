CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`lead_id` integer,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_calls_created_idx` ON `ai_calls` (`created_at`);--> statement-breakpoint
CREATE TABLE `ai_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`inbound_message_id` integer,
	`intent` text NOT NULL,
	`action` text NOT NULL,
	`confidence` real NOT NULL,
	`reasoning` text NOT NULL,
	`reply` text,
	`outcome` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbound_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`severity` text NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `browser_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`lead_id` integer,
	`url` text,
	`error` text NOT NULL,
	`screenshot_path` text,
	`snapshot_path` text,
	`console_errors` text DEFAULT '[]' NOT NULL,
	`network_failures` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`channel_state` text DEFAULT 'browser_contact_pending' NOT NULL,
	`channel_owner` text DEFAULT 'none' NOT NULL,
	`meta_igsid` text,
	`last_inbound_at` integer,
	`last_outbound_at` integer,
	`window_expires_at` integer,
	`followups_sent` integer DEFAULT 0 NOT NULL,
	`next_followup_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_lead_unique` ON `conversations` (`lead_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_igsid_unique` ON `conversations` (`meta_igsid`);--> statement-breakpoint
CREATE TABLE `do_not_contact` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`handle` text,
	`meta_igsid` text,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dnc_handle_unique` ON `do_not_contact` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `dnc_igsid_unique` ON `do_not_contact` (`meta_igsid`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`lead_id` integer,
	`job_id` integer,
	`actor` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `events_lead_idx` ON `events` (`lead_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`,`created_at`);--> statement-breakpoint
CREATE TABLE `exceptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `experiment_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`experiment_id` integer NOT NULL,
	`variant_id` integer NOT NULL,
	`lead_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `experiment_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_unique` ON `experiment_assignments` (`experiment_id`,`lead_id`);--> statement-breakpoint
CREATE TABLE `experiment_variants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`experiment_id` integer NOT NULL,
	`key` text NOT NULL,
	`is_control` integer DEFAULT false NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`created_by` text DEFAULT 'operator' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_key_unique` ON `experiment_variants` (`experiment_id`,`key`);--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`funnel` text NOT NULL,
	`variable` text NOT NULL,
	`hypothesis` text NOT NULL,
	`primary_metric` text DEFAULT 'replied' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`min_sample_per_variant` integer DEFAULT 50 NOT NULL,
	`exploration_rate` real DEFAULT 0.1 NOT NULL,
	`winner_variant_id` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`concluded_at` integer
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`run_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`lease_until` integer,
	`locked_by` text,
	`last_error` text,
	`idempotency_key` text,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_unique` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_ready_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`handle` text NOT NULL,
	`funnel` text NOT NULL,
	`pipeline_status` text DEFAULT 'discovered' NOT NULL,
	`display_name` text,
	`bio` text,
	`category` text,
	`location` text,
	`external_url` text,
	`followers` integer,
	`following` integer,
	`posts_count` integer,
	`signals` text DEFAULT '{}' NOT NULL,
	`source` text NOT NULL,
	`source_detail` text,
	`niche` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`score` real,
	`score_reasons` text DEFAULT '[]' NOT NULL,
	`role` text DEFAULT 'unknown' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`best_send_hour` integer,
	`next_action` text,
	`next_action_at` integer,
	`transacted_volume` real DEFAULT 0 NOT NULL,
	`referred_by_lead_id` integer,
	`closed_reason` text,
	`contacted_at` integer,
	`replied_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`referred_by_lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_handle_unique` ON `leads` (`handle`);--> statement-breakpoint
CREATE INDEX `leads_funnel_status_idx` ON `leads` (`funnel`,`pipeline_status`);--> statement-breakpoint
CREATE TABLE `locks` (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`direction` text NOT NULL,
	`channel` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`dedupe_key` text,
	`external_id` text,
	`experiment_id` integer,
	`variant_id` integer,
	`error` text,
	`sent_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `experiment_variants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_dedupe_unique` ON `messages` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_external_unique` ON `messages` (`external_id`);--> statement-breakpoint
CREATE INDEX `messages_lead_idx` ON `messages` (`lead_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `strategy_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`before` text,
	`after` text,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`status` text DEFAULT 'applied' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`reverted_at` integer
);
--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_id` text NOT NULL,
	`payload` text NOT NULL,
	`processed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_external_unique` ON `webhook_events` (`external_id`);