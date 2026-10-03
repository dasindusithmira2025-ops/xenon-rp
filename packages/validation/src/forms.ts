import { z } from 'zod';

import {
  cuid,
  discordSnowflake,
  hexColour,
  isoDate,
  optionalPlainText,
  plainText,
  publicId,
  reference,
  slug,
} from './primitives';
import { sanitizeRichText } from './sanitize';

/**
 * Input schemas for every form the platform accepts.
 *
 * One definition per operation, shared by the client form and by the server
 * action that actually commits it. The server always re-parses: client-side
 * validation is a convenience, never the boundary.
 */

/** Rich text written by staff. Sanitised as part of parsing, not afterwards. */
const richText = (max: number) =>
  z
    .string()
    .max(max * 2, 'That is too long.')
    .transform(sanitizeRichText)
    .pipe(z.string().max(max));

// --- Account and profile -----------------------------------------------------

export const profileInput = z.object({
  displayName: plainText(2, 32),
  pronouns: optionalPlainText(24),
  timezone: optionalPlainText(64),
  bio: optionalPlainText(400),
});
export type ProfileInput = z.infer<typeof profileInput>;

export const characterInput = z.object({
  firstName: plainText(2, 32),
  lastName: plainText(2, 32),
  alias: optionalPlainText(32),
  dateOfBirth: isoDate.optional(),
  occupation: optionalPlainText(64),
  backstory: optionalPlainText(4000),
});
export type CharacterInput = z.infer<typeof characterInput>;

export const acceptRulesInput = z.object({
  ruleSetId: cuid,
  acknowledged: z.literal(true, { error: 'You must accept the rules to continue.' }),
});

// --- Applications ------------------------------------------------------------

/** One autosaved answer. Deliberately permissive: a draft may be incomplete. */
export const answerDraft = z.object({
  questionKey: z.string().min(1).max(64),
  textValue: z.string().max(20_000).nullish(),
  numberValue: z.number().nullish(),
  booleanValue: z.boolean().nullish(),
  dateValue: z.string().max(40).nullish(),
  choiceValues: z.array(z.string().max(200)).max(64).optional(),
  mediaIds: z.array(cuid).max(16).optional(),
});
export type AnswerDraft = z.infer<typeof answerDraft>;

export const autosaveInput = z.object({
  submissionId: cuid,
  /** Revision the client last saw. A mismatch means another tab wrote first. */
  revision: z.number().int().min(0),
  answers: z.array(answerDraft).max(200),
});
export type AutosaveInput = z.infer<typeof autosaveInput>;

export const startApplicationInput = z.object({
  templateSlug: slug,
  characterId: cuid.optional(),
});

export const submitApplicationInput = z.object({
  submissionId: cuid,
  confirm: z.literal(true),
});

export const reviewDecisionInput = z.object({
  submissionId: reference,
  publicNote: optionalPlainText(2000),
  staffNote: optionalPlainText(2000),
});

export const rejectApplicationInput = reviewDecisionInput.extend({
  // A rejection the applicant cannot understand generates a ticket, so the
  // reason is mandatory here even though it is optional on other decisions.
  publicNote: plainText(10, 2000),
});

export const requestChangesInput = reviewDecisionInput.extend({
  publicNote: plainText(10, 2000),
});

export const assignReviewerInput = z.object({
  submissionId: reference,
  assigneeId: cuid.nullable(),
});

export const scheduleInterviewInput = z.object({
  submissionId: reference,
  scheduledFor: z.coerce.date(),
  location: optionalPlainText(200),
  hostId: cuid.optional(),
});

export const applicationCommentInput = z.object({
  submissionId: reference,
  body: plainText(1, 4000),
  visibility: z.enum(['INTERNAL', 'APPLICANT']).default('INTERNAL'),
});

// --- Application builder -----------------------------------------------------

export const questionTypeEnum = z.enum([
  'SHORT_TEXT',
  'LONG_TEXT',
  'NUMBER',
  'DATE',
  'SELECT',
  'MULTI_SELECT',
  'RADIO',
  'BOOLEAN',
  'CHECKBOX',
  'ACKNOWLEDGEMENT',
  'FILE',
  'IMAGE',
  'CHARACTER_SELECT',
]);

export const conditionOperatorEnum = z.enum([
  'EQUALS',
  'NOT_EQUALS',
  'CONTAINS',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
]);

export const templateInput = z.object({
  slug,
  name: plainText(2, 64),
  summary: optionalPlainText(160),
  description: optionalPlainText(2000),
  publicIdPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,4}$/, 'two to four uppercase letters, e.g. WL'),
  departmentId: cuid.nullish(),
  status: z.enum(['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED']).default('DRAFT'),
  opensAt: z.coerce.date().nullish(),
  closesAt: z.coerce.date().nullish(),
  minimumAccountAgeDays: z.coerce.number().int().min(0).max(3650).default(0),
  requiresGuildMember: z.boolean().default(true),
  requiresFivemLink: z.boolean().default(false),
  requiresRulesAccepted: z.boolean().default(true),
  requiresCharacter: z.boolean().default(false),
  requiredRoleKeys: z.array(z.string().max(64)).max(20).default([]),
  blockedRoleKeys: z.array(z.string().max(64)).max(20).default([]),
  rejectionCooldownDays: z.coerce.number().int().min(0).max(365).default(14),
  maxConcurrent: z.coerce.number().int().min(1).max(10).default(1),
  interviewRequired: z.boolean().default(false),
  allowResubmission: z.boolean().default(true),
  autoAssignReviewer: z.boolean().default(false),
  expiryDays: z.coerce.number().int().min(0).max(365).default(0),
  reviewChannelId: discordSnowflake.nullish(),
  notifyRoleId: discordSnowflake.nullish(),
  grantRoleKeys: z.array(z.string().max(64)).max(20).default([]),
  grantsWhitelist: z.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});
export type TemplateInput = z.infer<typeof templateInput>;

export const sectionInput = z.object({
  templateId: cuid,
  title: plainText(2, 80),
  description: optionalPlainText(500),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export const questionOptionInput = z.object({
  value: z.string().trim().min(1).max(64),
  label: plainText(1, 120),
  helpText: optionalPlainText(200),
});

export const questionInput = z
  .object({
    sectionId: cuid,
    key: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]{2,48}$/, 'lowercase letters, digits and underscores only'),
    type: questionTypeEnum,
    label: plainText(2, 200),
    helpText: optionalPlainText(500),
    placeholder: optionalPlainText(120),
    required: z.boolean().default(false),
    sortOrder: z.coerce.number().int().min(0).max(999).default(0),
    minLength: z.coerce.number().int().min(0).max(20_000).nullish(),
    maxLength: z.coerce.number().int().min(1).max(20_000).nullish(),
    minValue: z.coerce.number().nullish(),
    maxValue: z.coerce.number().nullish(),
    pattern: z.string().max(200).nullish(),
    staffOnly: z.boolean().default(false),
    visibleWhenQuestionKey: z.string().max(64).nullish(),
    visibleWhenOperator: conditionOperatorEnum.nullish(),
    visibleWhenValue: z.string().max(200).nullish(),
    maxFiles: z.coerce.number().int().min(1).max(16).nullish(),
    maxFileSizeBytes: z.coerce
      .number()
      .int()
      .min(1024)
      .max(25 * 1024 * 1024)
      .nullish(),
    allowedMimeTypes: z.array(z.string().max(120)).max(12).default([]),
    options: z.array(questionOptionInput).max(64).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      value.minLength !== null &&
      value.minLength !== undefined &&
      value.maxLength !== null &&
      value.maxLength !== undefined &&
      value.minLength > value.maxLength
    ) {
      ctx.addIssue({ code: 'custom', path: ['minLength'], message: 'Minimum exceeds maximum.' });
    }

    const needsOptions =
      value.type === 'SELECT' ||
      value.type === 'MULTI_SELECT' ||
      value.type === 'RADIO' ||
      value.type === 'CHECKBOX';
    if (needsOptions && value.options.length < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Add at least one option for this question type.',
      });
    }

    const duplicate = value.options.length !== new Set(value.options.map((o) => o.value)).size;
    if (duplicate) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option values must be unique.' });
    }

    // A half-configured condition would silently evaluate as "always visible",
    // which is the opposite of what the builder intended.
    const hasKey = Boolean(value.visibleWhenQuestionKey);
    const hasOperator = Boolean(value.visibleWhenOperator);
    if (hasKey !== hasOperator) {
      ctx.addIssue({
        code: 'custom',
        path: ['visibleWhenOperator'],
        message: 'Choose both a controlling question and a condition, or neither.',
      });
    }
  });
export type QuestionInput = z.infer<typeof questionInput>;

export const reorderInput = z.object({
  ids: z.array(cuid).min(1).max(200),
});

// --- Support, reports, appeals ----------------------------------------------

export const ticketInput = z.object({
  category: z.enum(['GENERAL', 'ACCOUNT', 'WHITELIST', 'TECHNICAL', 'PLAYER_REPORT', 'OTHER']),
  subject: plainText(4, 120),
  body: plainText(10, 5000),
  mediaIds: z.array(cuid).max(8).default([]),
});
export type TicketInput = z.infer<typeof ticketInput>;

export type TicketReplyInput = z.infer<typeof ticketReplyInput>;

export const ticketReplyInput = z.object({
  ticketId: cuid,
  body: plainText(1, 5000),
  visibility: z.enum(['INTERNAL', 'APPLICANT']).default('APPLICANT'),
  mediaIds: z.array(cuid).max(8).default([]),
});

export const ticketUpdateInput = z.object({
  ticketId: cuid,
  status: z.enum(['OPEN', 'WAITING_FOR_STAFF', 'WAITING_FOR_PLAYER', 'RESOLVED', 'CLOSED']),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  assigneeId: cuid.nullish(),
});

export const reportInput = z.object({
  kind: z.enum(['PLAYER', 'STAFF', 'BUG']),
  subjectPublicId: publicId.optional(),
  subjectLabel: optionalPlainText(120),
  summary: plainText(4, 140),
  details: plainText(20, 8000),
  occurredAt: z.coerce.date().optional(),
  mediaIds: z.array(cuid).max(10).default([]),
});
export type ReportInput = z.infer<typeof reportInput>;

export const reportUpdateInput = z.object({
  reportId: cuid,
  status: z.enum(['OPEN', 'INVESTIGATING', 'AWAITING_INFO', 'ACTIONED', 'DISMISSED', 'CLOSED']),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  assigneeId: cuid.nullish(),
  outcome: optionalPlainText(4000),
});

export const appealInput = z.object({
  kind: z.enum(['BAN', 'WHITELIST_REVOCATION', 'DEPARTMENT_REMOVAL', 'OTHER']),
  statement: plainText(40, 8000),
  sanctionRef: optionalPlainText(120),
  mediaIds: z.array(cuid).max(10).default([]),
});
export type AppealInput = z.infer<typeof appealInput>;

export const appealDecisionInput = z.object({
  appealId: cuid,
  status: z.enum(['UNDER_REVIEW', 'AWAITING_INFO', 'ACCEPTED', 'DENIED']),
  decision: plainText(10, 4000),
});

// --- Content -----------------------------------------------------------------

export const articleInput = z.object({
  slug,
  title: plainText(4, 140),
  excerpt: optionalPlainText(300),
  body: richText(60_000),
  heroImageUrl: z.url().nullish(),
  category: optionalPlainText(40),
  tags: z.array(z.string().trim().min(1).max(32)).max(10).default([]),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'),
  isPinned: z.boolean().default(false),
  publishedAt: z.coerce.date().nullish(),
});
export type ArticleInput = z.infer<typeof articleInput>;

export const announcementInput = z.object({
  title: plainText(4, 140),
  body: plainText(10, 4000),
  type: z
    .enum([
      'SERVER',
      'MAINTENANCE',
      'RESTART',
      'UPDATE',
      'PATCH_NOTES',
      'EVENT',
      'RECRUITMENT',
      'EMERGENCY',
      'COMMUNITY',
    ])
    .default('COMMUNITY'),
  toWebsite: z.boolean().default(true),
  toDiscord: z.boolean().default(false),
  discordChannelId: discordSnowflake.nullish(),
  discordNotifyRoleId: discordSnowflake.nullish(),
  scheduledAt: z.coerce.date().nullish(),
});
export type AnnouncementInput = z.infer<typeof announcementInput>;

export const galleryItemInput = z.object({
  mediaId: cuid,
  caption: optionalPlainText(200),
  photographer: optionalPlainText(60),
  event: optionalPlainText(80),
  tags: z.array(z.string().trim().min(1).max(32)).max(10).default([]),
  departmentId: cuid.nullish(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

export const departmentInput = z.object({
  slug,
  name: plainText(2, 64),
  shortName: optionalPlainText(16),
  tagline: optionalPlainText(140),
  description: optionalPlainText(1000),
  body: richText(40_000).optional(),
  heroImageUrl: z.url().nullish(),
  logoUrl: z.url().nullish(),
  accentColour: hexColour.nullish(),
  recruitmentState: z.enum(['OPEN', 'CLOSED', 'WAITLIST', 'INVITE_ONLY']).default('CLOSED'),
  requirements: z.array(plainText(2, 200)).max(20).default([]),
  roleKey: z.string().max(64).nullish(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});
export type DepartmentInput = z.infer<typeof departmentInput>;

// --- Rules -------------------------------------------------------------------

export const ruleCategoryInput = z.object({
  slug,
  name: plainText(2, 64),
  description: optionalPlainText(500),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

export const ruleInput = z.object({
  categoryId: cuid,
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,6}-\d{1,3}$/, 'e.g. GEN-4'),
  slug,
  title: plainText(4, 140),
  description: plainText(10, 8000),
  examples: optionalPlainText(4000),
  severity: z.enum(['GUIDELINE', 'STANDARD', 'SERIOUS', 'ZERO_TOLERANCE']).default('STANDARD'),
  aliases: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  changeNote: optionalPlainText(300),
});
export type RuleInput = z.infer<typeof ruleInput>;

export const publishRuleSetInput = z.object({
  note: optionalPlainText(300),
});

// --- Staff, roles, integrations ---------------------------------------------

export const roleInput = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{2,32}$/, 'lowercase letters, digits and underscores only'),
  name: plainText(2, 48),
  description: optionalPlainText(300),
  priority: z.coerce.number().int().min(0).max(1000).default(0),
  colour: hexColour.nullish(),
});

export const rolePermissionsInput = z.object({
  roleId: cuid,
  permissionKeys: z.array(z.string().max(64)).max(200),
});

export const assignRoleInput = z.object({
  userId: cuid,
  roleId: cuid,
  expiresAt: z.coerce.date().nullish(),
});

export const roleMappingInput = z.object({
  guildId: cuid,
  roleId: cuid,
  discordRoleId: discordSnowflake,
  discordRoleName: optionalPlainText(100),
  syncToDiscord: z.boolean().default(true),
  syncFromDiscord: z.boolean().default(false),
});

export const guildSettingsInput = z.object({
  guildId: discordSnowflake,
  name: plainText(1, 100),
  reviewChannelId: discordSnowflake.nullish(),
  announcementChannelId: discordSnowflake.nullish(),
  logChannelId: discordSnowflake.nullish(),
});

export const serverInput = z.object({
  slug,
  name: plainText(2, 64),
  adapter: z.enum(['MOCK', 'STANDALONE', 'QBCORE', 'QBX', 'ESX']).default('MOCK'),
  connectUrl: optionalPlainText(200),
  endpointUrl: z.url().nullish(),
  maxPlayers: z.coerce.number().int().min(1).max(2048).nullish(),
  restartCron: optionalPlainText(64),
  timezone: z.string().trim().max(64).default('Asia/Colombo'),
  isPublic: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export const whitelistDecisionInput = z.object({
  userId: cuid,
  reason: optionalPlainText(500),
});

export const featureFlagInput = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9_.]{3,64}$/, 'lowercase letters, digits, dots and underscores'),
  description: optionalPlainText(200),
  enabled: z.boolean().default(false),
  rollout: z.coerce.number().int().min(0).max(100).default(100),
  forceForRoleKeys: z.array(z.string().max(64)).max(20).default([]),
});

// --- FiveM -------------------------------------------------------------------

/**
 * The code a player types in game. Accepts the spaced and lowercase forms
 * people actually produce, and normalises before comparison.
 */
export const linkCodeInput = z
  .string()
  .trim()
  .toUpperCase()
  .transform((value) => value.replace(/[\s_]+/g, '-'))
  .pipe(z.string().regex(/^XEN-[A-Z0-9]{5}$/, 'Link codes look like XEN-7K4P9.'));

export const bridgeIdentityInput = z.object({
  kind: z.enum(['LICENSE', 'LICENSE2', 'STEAM', 'DISCORD', 'FIVEM', 'XBL', 'LIVE']),
  value: z.string().min(1).max(200),
});

export const bridgeLinkInput = z.object({
  code: linkCodeInput,
  identifiers: z.array(bridgeIdentityInput).min(1).max(12),
  playerName: z.string().max(80).optional(),
});
export type BridgeLinkInput = z.infer<typeof bridgeLinkInput>;

export const bridgeWhitelistCheckInput = z.object({
  identifiers: z.array(bridgeIdentityInput).min(1).max(12),
});
