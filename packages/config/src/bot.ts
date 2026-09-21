import { lazyEnv, parseEnv } from './parse';
import {
  datastoreSchema,
  discordSchema,
  fivemSchema,
  integrationsSchema,
  requireInProduction,
  runtimeSchema,
  securitySchema,
  siteSchema,
} from './schema';

import type { z } from 'zod';

/**
 * Configuration for the persistent Discord gateway service.
 *
 * Holds the bot token and no OAuth client secret: the bot never performs a
 * user-facing OAuth exchange.
 */
const botSchema = requireInProduction(
  runtimeSchema
    .extend(datastoreSchema.shape)
    .extend(securitySchema.shape)
    .extend(discordSchema.shape)
    .extend(integrationsSchema.shape)
    .extend(fivemSchema.shape)
    .extend({ NEXT_PUBLIC_SITE_URL: siteSchema.shape.NEXT_PUBLIC_SITE_URL }),
);

export type BotEnv = z.output<typeof botSchema>;

export const botEnv: BotEnv = lazyEnv(() => parseEnv('bot', botSchema, process.env));
