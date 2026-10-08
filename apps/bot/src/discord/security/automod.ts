import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  type Guild,
} from 'discord.js';

import type { DiscordRuntimeStore } from '../runtime-store';

export interface AutoModSyncResult {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly conflicts: readonly string[];
  readonly unavailable: string | null;
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

export function synchronizeAutoModRules(
  guild: Guild,
  store: DiscordRuntimeStore,
): Promise<AutoModSyncResult> {
  return withGuildSyncLock(guild.id, () => synchronizeAutoModRulesLocked(guild, store));
}

async function synchronizeAutoModRulesLocked(
  guild: Guild,
  store: DiscordRuntimeStore,
): Promise<AutoModSyncResult> {
  const created: string[] = [];
  const updated: string[] = [];
  const conflicts: string[] = [];
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
  const current = await guild.autoModerationRules.fetch();
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

  for (const definition of rules) {
    const ownedId = config.ownedAutoModRuleIds.find(
      (id) => current.get(id)?.name === definition.name,
    );
    const collision = current.find((rule) => rule.name === definition.name);
    const ruleId =
      ownedId ?? (collision !== undefined && ownedIds.has(collision.id) ? collision.id : null);
    if (collision !== undefined && ruleId === null) {
      conflicts.push(
        `${definition.name}: same-name rule exists but Xenon ownership is not recorded; left unchanged`,
      );
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
    if (ruleId === null) {
      const rule = await guild.autoModerationRules.create({
        ...options,
        triggerType: definition.triggerType,
      });
      await store.updateGuild(guild.id, (currentState) => ({
        ...currentState,
        security: {
          ...currentState.security,
          config: {
            ...currentState.security.config,
            ownedAutoModRuleIds: currentState.security.config.ownedAutoModRuleIds.includes(rule.id)
              ? currentState.security.config.ownedAutoModRuleIds
              : [...currentState.security.config.ownedAutoModRuleIds, rule.id],
          },
        },
      }));
      created.push(definition.name);
      continue;
    }
    const ownedRule = current.get(ruleId);
    if (ownedRule?.name !== definition.name || ownedRule.triggerType !== definition.triggerType) {
      conflicts.push(
        `${definition.name}: recorded rule no longer matches the Xenon baseline; left unchanged`,
      );
      continue;
    }
    await guild.autoModerationRules.edit(ruleId, options);
    updated.push(definition.name);
  }

  return { created, updated, conflicts, unavailable: null };
}
