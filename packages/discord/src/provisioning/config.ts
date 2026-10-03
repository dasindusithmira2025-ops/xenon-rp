import { z } from 'zod';

/**
 * Provisioning configuration schemas.
 *
 * Kept free of discord.js so the web tier can validate Control Center input
 * with exactly the schemas the bot plans with.
 */

/**
 * Optional parts of the server. Defaults favour fewer, busier channels: a dead
 * channel is worse than a missing one.
 */
export const blueprintFeaturesSchema = z.object({
  faq: z.boolean().default(false),
  introductions: z.boolean().default(false),
  media: z.boolean().default(true),
  clips: z.boolean().default(true),
  screenshots: z.boolean().default(false),
  offTopic: z.boolean().default(false),
  suggestions: z.boolean().default(true),
  communityHelp: z.boolean().default(true),
  departmentsDirectory: z.boolean().default(true),
  cityGuide: z.boolean().default(false),
  businessDirectory: z.boolean().default(false),
  laws: z.boolean().default(false),
  commands: z.boolean().default(false),
  whitelistInfo: z.boolean().default(true),
  recruitment: z.boolean().default(true),
  patchNotes: z.boolean().default(true),
  events: z.boolean().default(true),
  voiceLounges: z.boolean().default(true),
  tempVoice: z.boolean().default(true),
  languageRoles: z.boolean().default(false),
  applicationReview: z.boolean().default(false),
  staffResources: z.boolean().default(true),
  automod: z.boolean().default(false),
  livePresence: z.boolean().default(true),
});

export type BlueprintFeatures = z.output<typeof blueprintFeaturesSchema>;

export const featureLabels: Record<keyof BlueprintFeatures, string> = {
  faq: '#faq',
  introductions: '#introductions',
  media: '#media',
  clips: '#clips',
  screenshots: '#screenshots',
  offTopic: '#off-topic',
  suggestions: '#suggestions forum',
  communityHelp: '#community-help forum',
  departmentsDirectory: '#departments directory',
  cityGuide: '#city-guide',
  businessDirectory: '#business-directory',
  laws: '#laws',
  commands: '#commands',
  whitelistInfo: '#whitelist-info',
  recruitment: '#recruitment',
  patchNotes: '#patch-notes',
  events: '#events',
  voiceLounges: 'Chill and Gaming voice',
  tempVoice: 'Temporary voice rooms',
  languageRoles: 'Language roles',
  applicationReview: '#application-review',
  staffResources: '#staff-resources',
  automod: 'AutoMod safety rules',
  livePresence: 'Live bot presence',
};

/** Parse stored feature overrides; anything malformed falls back to defaults. */
export function parseFeatures(raw: unknown): BlueprintFeatures {
  const parsed = blueprintFeaturesSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : blueprintFeaturesSchema.parse({});
}

/** Stored on `Department.discordSpace`. Absent or disabled means no Discord space. */
export const departmentSpaceSchema = z.object({
  enabled: z.boolean().default(false),
  publicInfo: z.boolean().default(false),
  recruitment: z.boolean().default(true),
  private: z.boolean().default(true),
  command: z.boolean().default(true),
  voice: z.boolean().default(true),
  training: z.boolean().default(false),
  /** Xenon role whose holders receive the command Discord role. */
  commandRoleKey: z
    .string()
    .regex(/^[a-z0-9_.-]{1,64}$/)
    .optional(),
});

export type DepartmentSpace = z.output<typeof departmentSpaceSchema>;

export function parseDepartmentSpace(raw: unknown): DepartmentSpace {
  const parsed = departmentSpaceSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : departmentSpaceSchema.parse({});
}

export const organizationKinds = [
  'CREW',
  'STREET_GANG',
  'ORGANIZATION',
  'SYNDICATE',
  'BUSINESS',
] as const;

/**
 * A private Discord space for an approved organisation or business.
 *
 * Provisioned only when staff choose to. The key doubles as the logical key
 * suffix, so it is restricted to characters that are safe in a custom id.
 */
export const organizationSpaceSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/, 'Lowercase letters, digits and dashes, 2-32 characters'),
  name: z.string().trim().min(2).max(60),
  kind: z.enum(organizationKinds),
  /** Management may read the space. */
  staffVisible: z.boolean().default(true),
  /** The role shows the real name only when membership is public in RP. */
  publicMembership: z.boolean().default(false),
  archived: z.boolean().default(false),
});

export type OrganizationSpace = z.output<typeof organizationSpaceSchema>;

export const enforcementModes = ['OBSERVE', 'REPAIR', 'ENFORCE'] as const;
export type EnforcementMode = (typeof enforcementModes)[number];

export const SETTING_FEATURES = 'discord.blueprint.features';
export const SETTING_ENFORCEMENT = 'discord.provisioning.enforcement';

/** Typed phrase required before any provisioning mutation. */
export const PROVISION_PHRASE = 'PROVISION XENON';
/** Typed phrase required before deleting resources created by a failed run. */
export const CLEANUP_PHRASE = 'DELETE XENON RESOURCES';
/** An approved plan older than this must be regenerated before it is applied. */
export const PLAN_APPROVAL_TTL_MS = 30 * 60_000;
