-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('DISCORD_CONNECTED', 'GUILD_MEMBERSHIP', 'PROFILE', 'RULES', 'FIVEM_LINK', 'WHITELIST', 'COMPLETE');

-- CreateEnum
CREATE TYPE "WhitelistState" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "GameIdentityKind" AS ENUM ('LICENSE', 'LICENSE2', 'STEAM', 'DISCORD', 'FIVEM', 'XBL', 'LIVE');

-- CreateEnum
CREATE TYPE "LinkSource" AS ENUM ('FIVEM', 'STAFF', 'IMPORT');

-- CreateEnum
CREATE TYPE "CharacterStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED', 'DECEASED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApplicationTemplateStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('SHORT_TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTI_SELECT', 'RADIO', 'BOOLEAN', 'CHECKBOX', 'ACKNOWLEDGEMENT', 'FILE', 'IMAGE', 'CHARACTER_SELECT');

-- CreateEnum
CREATE TYPE "ConditionOperator" AS ENUM ('EQUALS', 'NOT_EQUALS', 'CONTAINS', 'IS_EMPTY', 'IS_NOT_EMPTY');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'RESUBMITTED', 'INTERVIEW_REQUIRED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('CLAIMED', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'INTERVIEW_REQUESTED', 'COMMENTED');

-- CreateEnum
CREATE TYPE "CommentVisibility" AS ENUM ('INTERNAL', 'APPLICANT');

-- CreateEnum
CREATE TYPE "ApplicationEventType" AS ENUM ('CREATED', 'SAVED', 'SUBMITTED', 'CLAIMED', 'UNCLAIMED', 'ASSIGNED', 'STATUS_CHANGED', 'CHANGES_REQUESTED', 'RESUBMITTED', 'INTERVIEW_REQUESTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'ARCHIVED', 'COMMENTED', 'NOTE_ADDED');

-- CreateEnum
CREATE TYPE "ActionSource" AS ENUM ('WEB', 'DISCORD', 'SYSTEM', 'FIVEM');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('REQUESTED', 'SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "InterviewOutcome" AS ENUM ('PASSED', 'FAILED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "RecruitmentState" AS ENUM ('OPEN', 'CLOSED', 'WAITLIST', 'INVITE_ONLY');

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RuleSeverity" AS ENUM ('GUIDELINE', 'STANDARD', 'SERIOUS', 'ZERO_TOLERANCE');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('GENERAL', 'ACCOUNT', 'WHITELIST', 'TECHNICAL', 'PLAYER_REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'WAITING_FOR_STAFF', 'WAITING_FOR_PLAYER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('PLAYER', 'STAFF', 'BUG');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'AWAITING_INFO', 'ACTIONED', 'DISMISSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AppealKind" AS ENUM ('BAN', 'WHITELIST_REVOCATION', 'DEPARTMENT_REMOVAL', 'OTHER');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'AWAITING_INFO', 'ACCEPTED', 'DENIED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('APPLICATION_SUBMITTED', 'APPLICATION_REVIEW_STARTED', 'APPLICATION_CHANGES_REQUESTED', 'APPLICATION_INTERVIEW_REQUESTED', 'APPLICATION_INTERVIEW_SCHEDULED', 'APPLICATION_APPROVED', 'APPLICATION_REJECTED', 'APPLICATION_EXPIRED', 'WHITELIST_GRANTED', 'WHITELIST_REVOKED', 'DEPARTMENT_STATUS_CHANGED', 'TICKET_REPLY', 'TICKET_RESOLVED', 'REPORT_UPDATE', 'APPEAL_DECISION', 'ACCOUNT_LINKED', 'SYSTEM_ANNOUNCEMENT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('WEB', 'DISCORD_DM', 'DISCORD_CHANNEL');

-- CreateEnum
CREATE TYPE "NotificationDeliveryState" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DiscordMessageKind" AS ENUM ('APPLICATION_REVIEW', 'TICKET_THREAD', 'ANNOUNCEMENT', 'STATUS_BOARD');

-- CreateEnum
CREATE TYPE "GameServerAdapterKind" AS ENUM ('MOCK', 'STANDALONE', 'QBCORE', 'QBX', 'ESX');

-- CreateEnum
CREATE TYPE "StorageDriver" AS ENUM ('R2', 'LOCAL');

-- CreateEnum
CREATE TYPE "MediaVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'STAFF_ONLY');

-- CreateEnum
CREATE TYPE "SystemValueKind" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "displayName" TEXT,
    "pronouns" TEXT,
    "timezone" TEXT,
    "avatarUrl" TEXT,
    "bio" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "onboardingStep" "OnboardingStep" NOT NULL DEFAULT 'DISCORD_CONNECTED',
    "whitelistState" "WhitelistState" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discord_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "globalName" TEXT,
    "discriminator" TEXT,
    "avatar" TEXT,
    "banner" TEXT,
    "locale" TEXT,
    "isGuildMember" BOOLEAN NOT NULL DEFAULT false,
    "guildNickname" TEXT,
    "guildJoinedAt" TIMESTAMP(3),
    "guildRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "syncedAt" TIMESTAMP(3),
    "syncFailedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discord_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "game_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "GameIdentityKind" NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkedVia" "LinkSource" NOT NULL DEFAULT 'FIVEM',
    "unlinkedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "game_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdIpHash" TEXT,

    CONSTRAINT "link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "colour" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "characters" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "alias" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "backstory" TEXT,
    "occupation" TEXT,
    "avatarUrl" TEXT,
    "status" "CharacterStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whitelists" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" "WhitelistState" NOT NULL DEFAULT 'NONE',
    "reason" TEXT,
    "grantedAt" TIMESTAMP(3),
    "grantedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "suspendedUntil" TIMESTAMP(3),
    "sourceSubmissionId" TEXT,
    "syncedAt" TIMESTAMP(3),
    "syncFailedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whitelists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_templates" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "summary" TEXT,
    "departmentId" TEXT,
    "status" "ApplicationTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "minimumAccountAgeDays" INTEGER NOT NULL DEFAULT 0,
    "requiresGuildMember" BOOLEAN NOT NULL DEFAULT true,
    "requiresFivemLink" BOOLEAN NOT NULL DEFAULT false,
    "requiresRulesAccepted" BOOLEAN NOT NULL DEFAULT true,
    "requiresCharacter" BOOLEAN NOT NULL DEFAULT false,
    "requiredRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockedRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rejectionCooldownDays" INTEGER NOT NULL DEFAULT 14,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
    "interviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "allowResubmission" BOOLEAN NOT NULL DEFAULT true,
    "autoAssignReviewer" BOOLEAN NOT NULL DEFAULT false,
    "expiryDays" INTEGER NOT NULL DEFAULT 0,
    "reviewChannelId" TEXT,
    "notifyRoleId" TEXT,
    "grantRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantsWhitelist" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "application_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_sections" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_questions" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "QuestionType" NOT NULL,
    "label" TEXT NOT NULL,
    "helpText" TEXT,
    "placeholder" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "minLength" INTEGER,
    "maxLength" INTEGER,
    "minValue" DOUBLE PRECISION,
    "maxValue" DOUBLE PRECISION,
    "pattern" TEXT,
    "visibleWhenQuestionKey" TEXT,
    "visibleWhenOperator" "ConditionOperator",
    "visibleWhenValue" TEXT,
    "staffOnly" BOOLEAN NOT NULL DEFAULT false,
    "maxFileSizeBytes" INTEGER,
    "allowedMimeTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxFiles" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_question_options" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "helpText" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "application_question_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_submissions" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "characterId" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "assigneeId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSavedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdIpHash" TEXT,

    CONSTRAINT "application_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_answers" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "textValue" TEXT,
    "numberValue" DOUBLE PRECISION,
    "booleanValue" BOOLEAN,
    "dateValue" TIMESTAMP(3),
    "choiceValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_reviews" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "publicNote" TEXT,
    "staffNote" TEXT,
    "source" "ActionSource" NOT NULL DEFAULT 'WEB',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_comments" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "CommentVisibility" NOT NULL DEFAULT 'INTERNAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "application_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_events" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "type" "ApplicationEventType" NOT NULL,
    "actorId" TEXT,
    "source" "ActionSource" NOT NULL DEFAULT 'SYSTEM',
    "fromStatus" "ApplicationStatus",
    "toStatus" "ApplicationStatus",
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_slots" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "templateId" TEXT,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "booked" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "hostId" TEXT,
    "slotId" TEXT,
    "status" "InterviewStatus" NOT NULL DEFAULT 'REQUESTED',
    "scheduledFor" TIMESTAMP(3),
    "location" TEXT,
    "outcome" "InterviewOutcome",
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "tagline" TEXT,
    "description" TEXT,
    "body" TEXT,
    "heroImageUrl" TEXT,
    "logoUrl" TEXT,
    "accentColour" TEXT,
    "recruitmentState" "RecruitmentState" NOT NULL DEFAULT 'CLOSED',
    "requirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "roleKey" TEXT,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_members" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" TEXT,
    "isLeadership" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "department_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rule_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rules" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "examples" TEXT,
    "severity" "RuleSeverity" NOT NULL DEFAULT 'STANDARD',
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_revisions" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "examples" TEXT,
    "severity" "RuleSeverity" NOT NULL,
    "editedBy" TEXT,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_sets" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "revisionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" TEXT,
    "note" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "rule_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_acceptances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ruleSetId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "rule_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "category" "TicketCategory" NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdIpHash" TEXT,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "CommentVisibility" NOT NULL DEFAULT 'APPLICANT',
    "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "ActionSource" NOT NULL DEFAULT 'WEB',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "kind" "ReportKind" NOT NULL,
    "reporterId" TEXT,
    "subjectId" TEXT,
    "subjectLabel" TEXT,
    "assigneeId" TEXT,
    "summary" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdIpHash" TEXT,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appeals" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "kind" "AppealKind" NOT NULL DEFAULT 'BAN',
    "statement" TEXT NOT NULL,
    "sanctionRef" TEXT,
    "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AppealStatus" NOT NULL DEFAULT 'SUBMITTED',
    "decision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdIpHash" TEXT,

    CONSTRAINT "appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "channels" "NotificationChannel"[] DEFAULT ARRAY['WEB']::"NotificationChannel"[],
    "webReadAt" TIMESTAMP(3),
    "discordState" "NotificationDeliveryState" NOT NULL DEFAULT 'PENDING',
    "discordSentAt" TIMESTAMP(3),
    "discordError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discord_guilds" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "iconUrl" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "reviewChannelId" TEXT,
    "announcementChannelId" TEXT,
    "logChannelId" TEXT,
    "memberCount" INTEGER,
    "syncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discord_guilds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discord_role_mappings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "discordRoleName" TEXT,
    "syncToDiscord" BOOLEAN NOT NULL DEFAULT true,
    "syncFromDiscord" BOOLEAN NOT NULL DEFAULT false,
    "hierarchyBlocked" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discord_role_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discord_message_references" (
    "id" TEXT NOT NULL,
    "kind" "DiscordMessageKind" NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "submissionId" TEXT,
    "ticketId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "discord_message_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "servers" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adapter" "GameServerAdapterKind" NOT NULL DEFAULT 'MOCK',
    "connectUrl" TEXT,
    "endpointUrl" TEXT,
    "maxPlayers" INTEGER,
    "restartCron" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Colombo',
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_status_snapshots" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "online" BOOLEAN NOT NULL,
    "playerCount" INTEGER,
    "maxPlayers" INTEGER,
    "queueLength" INTEGER,
    "latencyMs" INTEGER,
    "nextRestartAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_status_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "articles" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT,
    "body" TEXT NOT NULL,
    "heroImageUrl" TEXT,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorId" TEXT,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "announcedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gallery_items" (
    "id" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "caption" TEXT,
    "photographer" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "event" TEXT,
    "departmentId" TEXT,
    "uploadedById" TEXT,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gallery_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "driver" "StorageDriver" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum" TEXT,
    "originalName" TEXT,
    "visibility" "MediaVisibility" NOT NULL DEFAULT 'PRIVATE',
    "ownerId" TEXT,
    "purpose" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "source" "ActionSource" NOT NULL DEFAULT 'WEB',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityLabel" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "kind" "SystemValueKind" NOT NULL DEFAULT 'JSON',
    "category" TEXT NOT NULL DEFAULT 'general',
    "label" TEXT NOT NULL,
    "description" TEXT,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollout" INTEGER NOT NULL DEFAULT 100,
    "forceForRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "service_heartbeats" (
    "service" TEXT NOT NULL,
    "status" "ServiceStatus" NOT NULL DEFAULT 'UNKNOWN',
    "version" TEXT,
    "detail" JSONB,
    "beatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_heartbeats_pkey" PRIMARY KEY ("service")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_publicId_key" ON "users"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_whitelistState_idx" ON "users"("whitelistState");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "discord_accounts_userId_key" ON "discord_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "discord_accounts_discordId_key" ON "discord_accounts"("discordId");

-- CreateIndex
CREATE INDEX "discord_accounts_isGuildMember_idx" ON "discord_accounts"("isGuildMember");

-- CreateIndex
CREATE INDEX "discord_accounts_syncedAt_idx" ON "discord_accounts"("syncedAt");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_providerAccountId_key" ON "accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_sessionToken_key" ON "sessions"("sessionToken");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expires_idx" ON "sessions"("expires");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_key" ON "verification_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- CreateIndex
CREATE INDEX "game_identities_userId_idx" ON "game_identities"("userId");

-- CreateIndex
CREATE INDEX "game_identities_unlinkedAt_idx" ON "game_identities"("unlinkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "game_identities_kind_value_key" ON "game_identities"("kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "link_tokens_codeHash_key" ON "link_tokens"("codeHash");

-- CreateIndex
CREATE INDEX "link_tokens_userId_createdAt_idx" ON "link_tokens"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "link_tokens_expiresAt_idx" ON "link_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE INDEX "roles_priority_idx" ON "roles"("priority");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "permissions_category_idx" ON "permissions"("category");

-- CreateIndex
CREATE INDEX "role_permissions_permissionId_idx" ON "role_permissions"("permissionId");

-- CreateIndex
CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

-- CreateIndex
CREATE INDEX "user_roles_expiresAt_idx" ON "user_roles"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "characters_publicId_key" ON "characters"("publicId");

-- CreateIndex
CREATE INDEX "characters_userId_status_idx" ON "characters"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "whitelists_userId_key" ON "whitelists"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "whitelists_sourceSubmissionId_key" ON "whitelists"("sourceSubmissionId");

-- CreateIndex
CREATE INDEX "whitelists_state_idx" ON "whitelists"("state");

-- CreateIndex
CREATE INDEX "whitelists_syncedAt_idx" ON "whitelists"("syncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "application_templates_slug_key" ON "application_templates"("slug");

-- CreateIndex
CREATE INDEX "application_templates_status_sortOrder_idx" ON "application_templates"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "application_templates_departmentId_idx" ON "application_templates"("departmentId");

-- CreateIndex
CREATE INDEX "application_sections_templateId_sortOrder_idx" ON "application_sections"("templateId", "sortOrder");

-- CreateIndex
CREATE INDEX "application_questions_sectionId_sortOrder_idx" ON "application_questions"("sectionId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "application_questions_sectionId_key_key" ON "application_questions"("sectionId", "key");

-- CreateIndex
CREATE INDEX "application_question_options_questionId_sortOrder_idx" ON "application_question_options"("questionId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "application_question_options_questionId_value_key" ON "application_question_options"("questionId", "value");

-- CreateIndex
CREATE UNIQUE INDEX "application_submissions_publicId_key" ON "application_submissions"("publicId");

-- CreateIndex
CREATE INDEX "application_submissions_status_submittedAt_idx" ON "application_submissions"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "application_submissions_applicantId_status_idx" ON "application_submissions"("applicantId", "status");

-- CreateIndex
CREATE INDEX "application_submissions_templateId_status_idx" ON "application_submissions"("templateId", "status");

-- CreateIndex
CREATE INDEX "application_submissions_assigneeId_status_idx" ON "application_submissions"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "application_answers_questionId_idx" ON "application_answers"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "application_answers_submissionId_questionId_key" ON "application_answers"("submissionId", "questionId");

-- CreateIndex
CREATE INDEX "application_reviews_submissionId_createdAt_idx" ON "application_reviews"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "application_reviews_reviewerId_idx" ON "application_reviews"("reviewerId");

-- CreateIndex
CREATE INDEX "application_comments_submissionId_createdAt_idx" ON "application_comments"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "application_events_submissionId_createdAt_idx" ON "application_events"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "application_events_type_idx" ON "application_events"("type");

-- CreateIndex
CREATE INDEX "interview_slots_startsAt_idx" ON "interview_slots"("startsAt");

-- CreateIndex
CREATE INDEX "interview_slots_templateId_startsAt_idx" ON "interview_slots"("templateId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "interviews_publicId_key" ON "interviews"("publicId");

-- CreateIndex
CREATE INDEX "interviews_submissionId_idx" ON "interviews"("submissionId");

-- CreateIndex
CREATE INDEX "interviews_status_scheduledFor_idx" ON "interviews"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "departments_slug_key" ON "departments"("slug");

-- CreateIndex
CREATE INDEX "departments_status_sortOrder_idx" ON "departments"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "department_members_userId_idx" ON "department_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "department_members_departmentId_userId_key" ON "department_members"("departmentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "rule_categories_slug_key" ON "rule_categories"("slug");

-- CreateIndex
CREATE INDEX "rule_categories_sortOrder_idx" ON "rule_categories"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "rules_code_key" ON "rules"("code");

-- CreateIndex
CREATE UNIQUE INDEX "rules_slug_key" ON "rules"("slug");

-- CreateIndex
CREATE INDEX "rules_categoryId_sortOrder_idx" ON "rules"("categoryId", "sortOrder");

-- CreateIndex
CREATE INDEX "rules_status_idx" ON "rules"("status");

-- CreateIndex
CREATE UNIQUE INDEX "rule_revisions_ruleId_version_key" ON "rule_revisions"("ruleId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "rule_sets_version_key" ON "rule_sets"("version");

-- CreateIndex
CREATE INDEX "rule_sets_isCurrent_idx" ON "rule_sets"("isCurrent");

-- CreateIndex
CREATE INDEX "rule_acceptances_ruleSetId_idx" ON "rule_acceptances"("ruleSetId");

-- CreateIndex
CREATE UNIQUE INDEX "rule_acceptances_userId_ruleSetId_key" ON "rule_acceptances"("userId", "ruleSetId");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_publicId_key" ON "tickets"("publicId");

-- CreateIndex
CREATE INDEX "tickets_status_lastMessageAt_idx" ON "tickets"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "tickets_authorId_status_idx" ON "tickets"("authorId", "status");

-- CreateIndex
CREATE INDEX "tickets_assigneeId_status_idx" ON "tickets"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "ticket_messages_ticketId_createdAt_idx" ON "ticket_messages"("ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "reports_publicId_key" ON "reports"("publicId");

-- CreateIndex
CREATE INDEX "reports_kind_status_idx" ON "reports"("kind", "status");

-- CreateIndex
CREATE INDEX "reports_assigneeId_status_idx" ON "reports"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "reports_subjectId_idx" ON "reports"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "appeals_publicId_key" ON "appeals"("publicId");

-- CreateIndex
CREATE INDEX "appeals_status_createdAt_idx" ON "appeals"("status", "createdAt");

-- CreateIndex
CREATE INDEX "appeals_authorId_idx" ON "appeals"("authorId");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_webReadAt_idx" ON "notifications"("userId", "webReadAt");

-- CreateIndex
CREATE INDEX "notifications_discordState_idx" ON "notifications"("discordState");

-- CreateIndex
CREATE UNIQUE INDEX "discord_guilds_guildId_key" ON "discord_guilds"("guildId");

-- CreateIndex
CREATE INDEX "discord_role_mappings_roleId_idx" ON "discord_role_mappings"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "discord_role_mappings_guildId_discordRoleId_key" ON "discord_role_mappings"("guildId", "discordRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "discord_role_mappings_guildId_roleId_key" ON "discord_role_mappings"("guildId", "roleId");

-- CreateIndex
CREATE INDEX "discord_message_references_submissionId_idx" ON "discord_message_references"("submissionId");

-- CreateIndex
CREATE INDEX "discord_message_references_ticketId_idx" ON "discord_message_references"("ticketId");

-- CreateIndex
CREATE INDEX "discord_message_references_entityType_entityId_idx" ON "discord_message_references"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "discord_message_references_channelId_messageId_key" ON "discord_message_references"("channelId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "servers_slug_key" ON "servers"("slug");

-- CreateIndex
CREATE INDEX "server_status_snapshots_serverId_createdAt_idx" ON "server_status_snapshots"("serverId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "articles_slug_key" ON "articles"("slug");

-- CreateIndex
CREATE INDEX "articles_status_publishedAt_idx" ON "articles"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "articles_isPinned_publishedAt_idx" ON "articles"("isPinned", "publishedAt");

-- CreateIndex
CREATE INDEX "gallery_items_status_sortOrder_idx" ON "gallery_items"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "gallery_items_departmentId_idx" ON "gallery_items"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_storageKey_key" ON "media_assets"("storageKey");

-- CreateIndex
CREATE INDEX "media_assets_ownerId_idx" ON "media_assets"("ownerId");

-- CreateIndex
CREATE INDEX "media_assets_purpose_idx" ON "media_assets"("purpose");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_createdAt_idx" ON "audit_logs"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "system_settings_category_idx" ON "system_settings"("category");

-- AddForeignKey
ALTER TABLE "discord_accounts" ADD CONSTRAINT "discord_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_identities" ADD CONSTRAINT "game_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_tokens" ADD CONSTRAINT "link_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whitelists" ADD CONSTRAINT "whitelists_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_templates" ADD CONSTRAINT "application_templates_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_sections" ADD CONSTRAINT "application_sections_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "application_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_questions" ADD CONSTRAINT "application_questions_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "application_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_question_options" ADD CONSTRAINT "application_question_options_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "application_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "application_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_submissions" ADD CONSTRAINT "application_submissions_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "application_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "application_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_reviews" ADD CONSTRAINT "application_reviews_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "application_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_reviews" ADD CONSTRAINT "application_reviews_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_comments" ADD CONSTRAINT "application_comments_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "application_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_comments" ADD CONSTRAINT "application_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "application_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "application_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "interview_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rules" ADD CONSTRAINT "rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "rule_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_revisions" ADD CONSTRAINT "rule_revisions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_acceptances" ADD CONSTRAINT "rule_acceptances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_acceptances" ADD CONSTRAINT "rule_acceptances_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "rule_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discord_role_mappings" ADD CONSTRAINT "discord_role_mappings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "discord_guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discord_role_mappings" ADD CONSTRAINT "discord_role_mappings_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discord_message_references" ADD CONSTRAINT "discord_message_references_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "application_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discord_message_references" ADD CONSTRAINT "discord_message_references_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_status_snapshots" ADD CONSTRAINT "server_status_snapshots_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
