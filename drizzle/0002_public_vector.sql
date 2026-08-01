CREATE TABLE `actress_face_embeddings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actressId` int NOT NULL,
	`faceImageUrl` varchar(512) NOT NULL,
	`embedding` text NOT NULL,
	`embeddingDimension` int DEFAULT 128,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `actress_face_embeddings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `face_search_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`uploadedImageUrl` varchar(512) NOT NULL,
	`matchedActressIds` text,
	`topMatchActressId` int,
	`similarityScore` decimal(5,4),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `face_search_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `video_upload_chunks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionId` varchar(255) NOT NULL,
	`chunkIndex` int NOT NULL,
	`chunkSize` int NOT NULL,
	`storageKey` varchar(512) NOT NULL,
	`checksum` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `video_upload_chunks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `video_upload_sessions` (
	`id` varchar(255) NOT NULL,
	`userId` int NOT NULL,
	`fileName` varchar(512) NOT NULL,
	`fileSize` bigint NOT NULL,
	`totalChunks` int NOT NULL,
	`uploadedChunks` int NOT NULL DEFAULT 0,
	`uploadedChunkIds` text,
	`storageKey` varchar(512),
	`status` enum('uploading','processing','completed','failed') NOT NULL DEFAULT 'uploading',
	`metadata` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`expiresAt` timestamp,
	CONSTRAINT `video_upload_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `user_uploads` MODIFY COLUMN `s3Key` varchar(512);--> statement-breakpoint
ALTER TABLE `user_uploads` MODIFY COLUMN `s3Url` varchar(512);--> statement-breakpoint
ALTER TABLE `user_uploads` ADD `uploadType` enum('image','video') NOT NULL;--> statement-breakpoint
ALTER TABLE `user_uploads` ADD `fileUrl` text NOT NULL;--> statement-breakpoint
ALTER TABLE `user_uploads` ADD `metadata` text;--> statement-breakpoint
ALTER TABLE `video_upload_chunks` ADD CONSTRAINT `video_upload_chunks_sessionId_video_upload_sessions_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `video_upload_sessions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_uploads` DROP COLUMN `fileType`;