CREATE TABLE `auth_login_attempts` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`first_failed_at` text NOT NULL,
	`blocked_until` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_auth` (
	`id` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_iterations` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
