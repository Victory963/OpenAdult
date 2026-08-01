CREATE TABLE `ad_impressions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`adId` int NOT NULL,
	`videoId` int,
	`userId` int,
	`event` enum('impression','start','firstQuartile','midpoint','thirdQuartile','complete','click') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ad_impressions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ad_placements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`videoId` int,
	`adId` int NOT NULL,
	`position` enum('pre-roll','mid-roll','post-roll') NOT NULL,
	`insertAtSeconds` int,
	`midRollInterval` int,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ad_placements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`type` enum('pre-roll','mid-roll','post-roll') NOT NULL,
	`videoUrl` varchar(512) NOT NULL,
	`thumbnailUrl` varchar(512),
	`clickUrl` varchar(512),
	`duration` int NOT NULL,
	`priority` int DEFAULT 0,
	`isActive` boolean NOT NULL DEFAULT true,
	`impressions` int DEFAULT 0,
	`clicks` int DEFAULT 0,
	`completions` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `video_upload_sessions` MODIFY COLUMN `metadata` mediumtext;