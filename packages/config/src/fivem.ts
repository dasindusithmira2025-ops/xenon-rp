import { z } from 'zod';

import { lazyEnv, parseEnv } from './parse';
import { fivemSchema, requireInProduction, runtimeSchema } from './schema';

/**
 * Configuration for the game-server integration (`@xenon/fivem`).
 *
 * Split out of the web contract so the worker and Core API can sign bridge
 * requests without having to carry the website's OAuth secrets. Production
 * refuses to start without FIVEM_BRIDGE_SECRET: an unsigned bridge would let
 * anyone on the network push whitelist decisions.
 *
 * FIVEM_ADMISSION_MODE decides which linked identities can admit a player:
 *  - `cfx-or-legacy` (default): the website-verified Cfx.re account, plus
 *    Rockstar licences linked by the retired in-game code flow or by staff.
 *  - `cfx-only`: the Cfx.re account only, plus staff-granted licence
 *    exceptions. Switch once existing players have linked Cfx.re.
 */
const fivemEnvSchema = requireInProduction(
  runtimeSchema.extend(fivemSchema.shape).extend({
    FIVEM_ADMISSION_MODE: z.enum(['cfx-or-legacy', 'cfx-only']).default('cfx-or-legacy'),
  }),
);

export type FivemEnv = z.output<typeof fivemEnvSchema>;

export function parseFivemEnv(source: Record<string, string | undefined>): FivemEnv {
  return parseEnv('fivem', fivemEnvSchema, source);
}

export const fivemEnv: FivemEnv = lazyEnv(() => parseFivemEnv(process.env));
