DROP TABLE `mailbox_ai_usage`;--> statement-breakpoint
DROP TABLE `mailbox_spam_usage`;--> statement-breakpoint
DROP TABLE `thread_summary`;--> statement-breakpoint
ALTER TABLE `mailbox` DROP COLUMN `spam_ai_token_cap`;--> statement-breakpoint
ALTER TABLE `mailbox` DROP COLUMN `ai_features`;--> statement-breakpoint
ALTER TABLE `mailbox` DROP COLUMN `ai_token_cap`;--> statement-breakpoint
ALTER TABLE `message` DROP COLUMN `ai_summary`;--> statement-breakpoint
ALTER TABLE `message` DROP COLUMN `ai_category`;--> statement-breakpoint
ALTER TABLE `message` DROP COLUMN `ai_priority`;--> statement-breakpoint
ALTER TABLE `thread` DROP COLUMN `ai_summary`;--> statement-breakpoint
ALTER TABLE `thread` DROP COLUMN `ai_category`;--> statement-breakpoint
ALTER TABLE `thread` DROP COLUMN `ai_priority`;