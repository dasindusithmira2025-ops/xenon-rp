CREATE TYPE "AnnouncementType" AS ENUM (
  'SERVER',
  'MAINTENANCE',
  'RESTART',
  'UPDATE',
  'PATCH_NOTES',
  'EVENT',
  'RECRUITMENT',
  'EMERGENCY',
  'COMMUNITY'
);

ALTER TABLE "articles"
  ADD COLUMN "announcementType" "AnnouncementType" NOT NULL DEFAULT 'COMMUNITY',
  ADD COLUMN "publishToWebsite" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "publishToDiscord" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "discordChannelId" TEXT,
  ADD COLUMN "discordNotifyRoleId" TEXT,
  ADD COLUMN "scheduledAt" TIMESTAMP(3);

CREATE INDEX "articles_scheduledAt_idx" ON "articles"("scheduledAt");
