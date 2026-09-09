CREATE TABLE IF NOT EXISTS `user` (
  `id` Utf8 NOT NULL,
  `name` Utf8 NOT NULL,
  `email` Utf8 NOT NULL,
  `emailVerified` Bool NOT NULL,
  `image` Utf8,
  `createdAt` Timestamp NOT NULL,
  `updatedAt` Timestamp NOT NULL,
  INDEX `idx_user_email` GLOBAL UNIQUE SYNC ON (`email`),
  PRIMARY KEY (`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `session` (
  `id` Utf8 NOT NULL,
  `expiresAt` Timestamp NOT NULL,
  `token` Utf8 NOT NULL,
  `createdAt` Timestamp NOT NULL,
  `updatedAt` Timestamp NOT NULL,
  `ipAddress` Utf8,
  `userAgent` Utf8,
  `userId` Utf8 NOT NULL,
  INDEX `idx_session_token` GLOBAL UNIQUE SYNC ON (`token`),
  INDEX `idx_session_userId` GLOBAL SYNC ON (`userId`),
  PRIMARY KEY (`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `account` (
  `id` Utf8 NOT NULL,
  `accountId` Utf8 NOT NULL,
  `providerId` Utf8 NOT NULL,
  `userId` Utf8 NOT NULL,
  `accessToken` Utf8,
  `refreshToken` Utf8,
  `idToken` Utf8,
  `accessTokenExpiresAt` Timestamp,
  `refreshTokenExpiresAt` Timestamp,
  `scope` Utf8,
  `password` Utf8,
  `createdAt` Timestamp NOT NULL,
  `updatedAt` Timestamp NOT NULL,
  INDEX `idx_account_userId` GLOBAL SYNC ON (`userId`),
  PRIMARY KEY (`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `verification` (
  `id` Utf8 NOT NULL,
  `identifier` Utf8 NOT NULL,
  `value` Utf8 NOT NULL,
  `expiresAt` Timestamp NOT NULL,
  `createdAt` Timestamp NOT NULL,
  `updatedAt` Timestamp NOT NULL,
  INDEX `idx_verification_identifier` GLOBAL SYNC ON (`identifier`),
  PRIMARY KEY (`id`)
);
