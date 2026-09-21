
import { parseEnv } from './parse';
import { siteSchema } from './schema';

import type { z } from 'zod';

/**
 * Browser-visible configuration.
 *
 * Every value is read through an explicit `process.env.NEXT_PUBLIC_*` member
 * expression because that is the only form the Next.js compiler can inline into
 * a client bundle. Dynamic lookup would silently yield `undefined` in the browser.
 */
export const publicEnv = parseEnv('public', siteSchema, {
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
});

export type PublicEnv = z.output<typeof siteSchema>;
