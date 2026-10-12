-- Additive only: three new tables and their enums. No existing table is altered.

-- CreateEnum
CREATE TYPE "OutboxKind" AS ENUM ('JOB', 'EVENT');

-- CreateEnum
CREATE TYPE "ModerationScope" AS ENUM ('PLATFORM', 'DISCORD', 'FIVEM');

-- CreateEnum
CREATE TYPE "ModerationKind" AS ENUM ('NOTE', 'WARN', 'KICK', 'SUSPEND', 'BAN');

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" TEXT NOT NULL,
    "kind" "OutboxKind" NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "source" "ActionSource" NOT NULL DEFAULT 'SYSTEM',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_event_receipts" (
    "consumer" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_event_receipts_pkey" PRIMARY KEY ("consumer","eventId")
);

-- CreateTable
CREATE TABLE "moderation_cases" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "identifierHash" TEXT,
    "scope" "ModerationScope" NOT NULL,
    "kind" "ModerationKind" NOT NULL,
    "source" "ActionSource" NOT NULL,
    "reason" TEXT NOT NULL,
    "externalRef" TEXT,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_dedupeKey_key" ON "outbox_messages"("dedupeKey");

-- CreateIndex
CREATE INDEX "outbox_messages_dispatchedAt_availableAt_idx" ON "outbox_messages"("dispatchedAt", "availableAt");

-- CreateIndex
CREATE INDEX "outbox_messages_kind_name_createdAt_idx" ON "outbox_messages"("kind", "name", "createdAt");

-- CreateIndex
CREATE INDEX "integration_event_receipts_processedAt_idx" ON "integration_event_receipts"("processedAt");

-- CreateIndex
CREATE INDEX "moderation_cases_userId_createdAt_idx" ON "moderation_cases"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "moderation_cases_identifierHash_idx" ON "moderation_cases"("identifierHash");

-- CreateIndex
CREATE UNIQUE INDEX "moderation_cases_source_externalRef_key" ON "moderation_cases"("source", "externalRef");

-- AddForeignKey
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
