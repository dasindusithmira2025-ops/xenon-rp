import { publicEnv } from '@xenon/config/public';

import type { MetadataRoute } from 'next';

/**
 * Robots policy.
 *
 * The public site is fully crawlable. Everything behind a session is not:
 * /portal and /control are per-user and authorization-gated, /api is machine
 * surface, and /signin exists only to bounce to Discord. Disallowing them is
 * not a security control - the server-side checks are - but it keeps them out
 * of search results and off crawler budgets.
 */
export default function robots(): MetadataRoute.Robots {
  const base = publicEnv.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/portal', '/control', '/api', '/signin'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
