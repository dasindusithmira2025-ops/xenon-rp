ALTER TYPE "ActionSource" ADD VALUE 'CLI';

ALTER TABLE "departments" ADD COLUMN "discordSpace" JSONB;

CREATE TYPE "DiscordResourceType" AS ENUM (
  'ROLE',
  'CATEGORY',
  'CHANNEL',
  'EMOJI',
  'STICKER',
  'PANEL',
  'SPACE',
  'AUTOMOD'
);

CREATE TYPE "DiscordProvisionMode" AS ENUM (
  'PLAN',
  'APPLY',
  'STATUS',
  'REPAIR',
  'VALIDATE',
  'CLEANUP'
);

CREATE TYPE "DiscordProvisionStatus" AS ENUM (
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'VALIDATION_FAILED'
);

CREATE TABLE "discord_managed_resources" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "logicalKey" TEXT NOT NULL,
  "resourceType" "DiscordResourceType" NOT NULL,
  "discordResourceId" TEXT,
  "channelId" TEXT,
  "blueprintVersion" TEXT NOT NULL,
  "contentHash" TEXT,
  "configurationHash" TEXT,
  "managed" BOOLEAN NOT NULL DEFAULT true,
  "createdByRunId" TEXT,
  "lastVerifiedAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "discord_managed_resources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "discord_managed_resources_guildId_logicalKey_key"
  ON "discord_managed_resources"("guildId", "logicalKey");
CREATE INDEX "discord_managed_resources_guildId_resourceType_idx"
  ON "discord_managed_resources"("guildId", "resourceType");
CREATE INDEX "discord_managed_resources_createdByRunId_idx"
  ON "discord_managed_resources"("createdByRunId");

CREATE TABLE "discord_provision_runs" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "mode" "DiscordProvisionMode" NOT NULL,
  "status" "DiscordProvisionStatus" NOT NULL DEFAULT 'QUEUED',
  "source" "ActionSource" NOT NULL,
  "actorId" TEXT,
  "actorLabel" TEXT NOT NULL,
  "blueprintVersion" TEXT NOT NULL,
  "basedOnRunId" TEXT,
  "options" JSONB NOT NULL DEFAULT '{}',
  "plannedChanges" JSONB,
  "appliedChanges" JSONB,
  "progress" JSONB,
  "summary" JSONB,
  "failure" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "discord_provision_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "discord_provision_runs_guildId_createdAt_idx"
  ON "discord_provision_runs"("guildId", "createdAt");
CREATE INDEX "discord_provision_runs_status_idx" ON "discord_provision_runs"("status");
