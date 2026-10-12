import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  DiscordAPIError,
  type Guild,
} from 'discord.js';

import type { DiscordRuntimeStore } from '../runtime-store';

export interface AutoModSyncResult {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly skipped: readonly string[];
  readonly conflicts: readonly string[];
  readonly xenonOwnedRuleCount: number | null;
  readonly existingServerRules: readonly AutoModServerRule[];
  readonly unavailable: string | null;
}

export interface AutoModServerRule {
  readonly name: string;
  readonly triggerType: AutoModerationRuleTriggerType;
  readonly enabled: boolean;
}

interface RuleDefinition {
  readonly name: string;
  readonly triggerType: AutoModerationRuleTriggerType;
  readonly triggerMetadata: {
    readonly mentionTotalLimit?: number;
    readonly keywordFilter?: readonly string[];
    readonly regexPatterns?: readonly string[];
  };
}

const INVITE_REGEX = String.raw`(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[^\s]+`;
const INVITE_RULE_NAME = 'XENON | Invite Protection';
const MENTION_RULE_NAME = 'XENON | Mention Spam';
const KEYWORD_RULE_NAME = 'XENON | Security Keywords';
const RULE_LIMITS = new Map<AutoModerationRuleTriggerType, number>([
  [AutoModerationRuleTriggerType.Keyword, 6],
  [AutoModerationRuleTriggerType.MentionSpam, 1],
]);

const guildSyncTails = new Map<string, Promise<void>>();

async function withGuildSyncLock<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
  const previous = guildSyncTails.get(guildId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  guildSyncTails.set(guildId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (guildSyncTails.get(guildId) === tail) guildSyncTails.delete(guildId);
  }
}

/** `beforeMutation` runs immediately before every Discord write and may throw to abort the sync. */
export function synchronizeAutoModRules(
  guild: Guild,
  store: DiscordRuntimeStore,
  beforeMutation?: () => Promise<void>,
): Promise<AutoModSyncResult> {
  return withGuildSyncLock(guild.id, () =>
    synchronizeAutoModRulesLocked(guild, store, beforeMutation),
  );
}

async function synchronizeAutoModRulesLocked(
  guild: Guild,
  store: DiscordRuntimeStore,
  beforeMutation: (() => Promise<void>) | undefined,
): Promise<AutoModSyncResult> {
  const created: string[] = [];
  const updated: string[] = [];
  const conflicts: string[] = [];
  const skipped: string[] = [];
  const state = await store.getGuild(guild.id);
  const config = state.security.config;
  const ownedIds = new Set(config.ownedAutoModRuleIds);
  const rules = [
    {
      name: MENTION_RULE_NAME,
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      triggerMetadata: { mentionTotalLimit: 5 },
    },
    {
      name: INVITE_RULE_NAME,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: { regexPatterns: [INVITE_REGEX] },
    },
    {
      name: KEYWORD_RULE_NAME,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: {
        keywordFilter: [...new Set(['free nitro', 'nitro gift', ...config.prohibitedKeywords])],
      },
    },
  ] satisfies readonly RuleDefinition[];
  const alertActions =
    config.channels.audit === null
      ? []
      : [
          {
            type: AutoModerationActionType.SendAlertMessage,
            metadata: { channel: config.channels.audit },
          },
        ];
  const actions = [{ type: AutoModerationActionType.BlockMessage }, ...alertActions];
  let current: Awaited<ReturnType<Guild['autoModerationRules']['fetch']>>;
  try {
    current = await guild.autoModerationRules.fetch();
  } catch (error) {
    if (!(error instanceof DiscordAPIError)) throw error;
    return {
      created,
      updated,
      skipped,
      conflicts,
      xenonOwnedRuleCount: null,
      existingServerRules: [],
      unavailable: formatDiscordApiError(error),
    };
  }
  const missingOwnedIds = new Set(config.ownedAutoModRuleIds.filter((id) => !current.has(id)));
  if (missingOwnedIds.size > 0) {
    await store.updateGuild(guild.id, (currentState) => ({
      ...currentState,
      security: {
        ...currentState.security,
        config: {
          ...currentState.security.config,
          ownedAutoModRuleIds: currentState.security.config.ownedAutoModRuleIds.filter(
            (id) => !missingOwnedIds.has(id),
          ),
        },
      },
    }));
  }
  const existingServerRules = [...current.values()]
    .filter((rule) => !ownedIds.has(rule.id))
    .map(({ name, triggerType, enabled }) => ({ name, triggerType, enabled }));
  const triggerCounts = new Map<AutoModerationRuleTriggerType, number>();
  let xenonOwnedRuleCount = 0;
  for (const rule of current.values()) {
    triggerCounts.set(rule.triggerType, (triggerCounts.get(rule.triggerType) ?? 0) + 1);
    if (ownedIds.has(rule.id)) xenonOwnedRuleCount += 1;
  }

  for (const definition of rules) {
    const ownedId = config.ownedAutoModRuleIds.find(
      (id) => current.get(id)?.name === definition.name,
    );
    const collision = current.find((rule) => rule.name === definition.name);
    const ruleId =
      ownedId ?? (collision !== undefined && ownedIds.has(collision.id) ? collision.id : null);
    if (collision !== undefined && ruleId === null) {
      const message = `${definition.name}: same-name rule exists but Xenon ownership is not recorded; left unchanged`;
      conflicts.push(message);
      skipped.push(`${definition.name}: skipped because an unowned same-name rule already exists`);
      continue;
    }
    const options = {
      name: definition.name,
      eventType: AutoModerationRuleEventType.MessageSend,
      triggerMetadata: definition.triggerMetadata,
      actions,
      enabled: true,
      reason: 'Xenon security baseline sync',
    };
    const limit = RULE_LIMITS.get(definition.triggerType);
    const count = triggerCounts.get(definition.triggerType) ?? 0;
    if (ruleId === null && limit !== undefined && count >= limit) {
      const occupyingRules = [...current.values()].filter(
        (rule) => rule.triggerType === definition.triggerType,
      );
      const summary = occupyingRules
        .map(
          (rule) =>
            `${rule.name} (${ownedIds.has(rule.id) ? 'Xenon-owned' : 'server-wide'}, ${rule.enabled ? 'enabled' : 'disabled'})`,
        )
        .join(', ');
      skipped.push(
        `${definition.name}: skipped; trigger type ${String(definition.triggerType)} limit ${String(limit)} reached (${summary}).`,
      );
      const unownedRules = occupyingRules.filter((rule) => !ownedIds.has(rule.id));
      if (unownedRules.length > 0)
        conflicts.push(
          `${definition.name}: existing non-Xenon rule(s) already use this trigger capacity and were left untouched: ${unownedRules.map((rule) => rule.name).join(', ')}`,
        );
      continue;
    }
    if (ruleId === null) {
      await beforeMutation?.();
      let createdRuleId: string;
      try {
        const rule = await guild.autoModerationRules.create({
          ...options,
          triggerType: definition.triggerType,
        });
        createdRuleId = rule.id;
      } catch (error) {
        if (!(error instanceof DiscordAPIError)) throw error;
        const reason = formatDiscordApiError(error);
        skipped.push(`${definition.name}: create failed (${reason})`);
        conflicts.push(`${definition.name}: Discord rejected rule creation (${reason})`);
        continue;
      }
      await store.updateGuild(guild.id, (currentState) => ({
        ...currentState,
        security: {
          ...currentState.security,
          config: {
            ...currentState.security.config,
            ownedAutoModRuleIds: currentState.security.config.ownedAutoModRuleIds.includes(
              createdRuleId,
            )
              ? currentState.security.config.ownedAutoModRuleIds
              : [...currentState.security.config.ownedAutoModRuleIds, createdRuleId],
          },
        },
      }));
      ownedIds.add(createdRuleId);
      xenonOwnedRuleCount += 1;
      triggerCounts.set(definition.triggerType, count + 1);
      created.push(definition.name);
      continue;
    }
    const ownedRule = current.get(ruleId);
    if (ownedRule?.name !== definition.name || ownedRule.triggerType !== definition.triggerType) {
      conflicts.push(
        `${definition.name}: recorded rule no longer matches the Xenon baseline; left unchanged`,
      );
      skipped.push(
        `${definition.name}: skipped because the recorded rule does not match the baseline`,
      );
      continue;
    }
    await beforeMutation?.();
    try {
      await guild.autoModerationRules.edit(ruleId, options);
    } catch (error) {
      if (!(error instanceof DiscordAPIError)) throw error;
      const reason = formatDiscordApiError(error);
      skipped.push(`${definition.name}: update failed (${reason})`);
      conflicts.push(`${definition.name}: Discord rejected the rule update (${reason})`);
      continue;
    }
    updated.push(definition.name);
  }

  return {
    created,
    updated,
    skipped,
    conflicts,
    xenonOwnedRuleCount,
    existingServerRules,
    unavailable: null,
  };
}

function formatDiscordApiError(error: DiscordAPIError): string {
  return `Discord API ${String(error.code)}: ${error.message.replace(/\s+/g, ' ').slice(0, 200)}`;
}
