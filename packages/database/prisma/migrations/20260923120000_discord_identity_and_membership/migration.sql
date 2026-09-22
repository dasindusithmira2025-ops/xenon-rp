CREATE TYPE "DiscordMembershipState" AS ENUM (
  'UNKNOWN',
  'MEMBER',
  'PENDING_SCREENING',
  'NOT_MEMBER',
  'UNAVAILABLE',
  'MISCONFIGURED'
);

ALTER TABLE "discord_accounts"
  ADD COLUMN "guildMembershipState" "DiscordMembershipState" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "guildSyncedAt" TIMESTAMP(3),
  ADD COLUMN "guildSyncError" TEXT;

CREATE INDEX "discord_accounts_guildMembershipState_idx"
  ON "discord_accounts"("guildMembershipState");

-- Historical booleans do not prove a fresh membership lookup. Force the first
-- explicit bot resync to establish this snapshot before membership gating.
UPDATE "discord_accounts"
SET "isGuildMember" = FALSE,
    "guildNickname" = NULL,
    "guildJoinedAt" = NULL,
    "guildRoleIds" = ARRAY[]::TEXT[];

-- OAuth identify is sufficient for Xenon. Tokens persisted by the former stock
-- adapter are not needed for membership or profile work and are removed in bulk.
UPDATE "accounts"
SET "refresh_token" = NULL,
    "access_token" = NULL,
    "expires_at" = NULL,
    "token_type" = NULL,
    "scope" = NULL,
    "id_token" = NULL,
    "session_state" = NULL
WHERE "provider" = 'discord';
