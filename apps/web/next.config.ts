// Side-effect import, and it must come first. Next.js reads `.env` relative to
// the app directory, but this monorepo keeps a single `.env` at the root so the
// web tier, the bot and the Prisma CLI cannot drift apart. Loading it here puts
// the values in `process.env` before Next evaluates anything else, which is
// what makes NEXT_PUBLIC_* inlining work during a build.
import '@xenon/config/load-env';

import type { NextConfig } from 'next';

/** Origin of the Cfx.re forum used for account linking (CFX_FORUM_URL, default forum.cfx.re). */
function cfxForumOrigin(): string {
  try {
    return new URL(process.env.CFX_FORUM_URL ?? 'https://forum.cfx.re').origin;
  } catch {
    return 'https://forum.cfx.re';
  }
}

/**
 * Content Security Policy.
 *
 * Written out rather than generated so that every allowance is a visible,
 * deliberate decision. Two notes on the parts that are not as tight as they
 * look like they should be:
 *
 *  - `'unsafe-inline'` on style-src is required by Next.js, which inlines
 *    critical CSS, and by Radix, which sets positioning styles on portalled
 *    elements. Style injection is a defacement risk rather than a script
 *    execution one, and the alternative is a nonce plumbed through every
 *    component.
 *  - `'unsafe-eval'` is allowed only in development, where React Refresh needs
 *    it. Production gets neither.
 */
function contentSecurityPolicy(isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // Discord avatars, and any CDN the operator configures for media.
    "img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net https:",
    "media-src 'self' https: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    "frame-src 'self' https://challenges.cloudflare.com",
    // "Connect Cfx.re" is a same-origin form whose response redirects to the
    // Cfx.re forum's consent page; browsers check that redirect against
    // form-action, so the forum origin must be listed.
    `form-action 'self' ${cfxForumOrigin()}`,
    // Nothing on this site should ever be framed: the control centre has
    // destructive buttons, and clickjacking is exactly how they get clicked.
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

const isDev = process.env.NODE_ENV !== 'production';

/**
 * The media CDN as an image source.
 *
 * Gallery photographs and the hero poster are served from `R2_PUBLIC_URL`, and
 * `next/image` answers 400 for any host that is not listed. Read from the
 * environment rather than hard-coded because the bucket's domain is the
 * operator's, not ours. Unset or malformed means there is no CDN host to allow.
 */
function mediaImagePatterns(): NonNullable<NextConfig['images']>['remotePatterns'] {
  const raw = process.env.R2_PUBLIC_URL;
  if (raw === undefined || raw === '') return [];
  try {
    const { protocol, hostname, port } = new URL(raw);
    return [{ protocol: protocol === 'http:' ? 'http' : 'https', hostname, port }];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /*
   * Next keeps its dev-server lock inside the build directory and refuses a
   * second dev server for the same one. The E2E suite sets this so it can run
   * against its own server without making the developer stop theirs.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',

  experimental: {
    /*
     * Required by `unauthorized()` and `forbidden()`, which every gated page
     * and server action reaches through src/server/context.ts. Without this
     * they throw instead of rendering app/unauthorized.tsx and
     * app/forbidden.tsx, and a signed-out visit to /portal returns a blank
     * document - which is exactly what it did until an end-to-end test
     * navigated to one.
     */
    authInterrupts: true,
  },

  // Next.js writes AGENTS.md / CLAUDE.md into the app directory unless told
  // not to. This repository documents itself in docs/, and generated files
  // that reappear after every dev boot are noise in `git status`.
  agentRules: false,

  // Workspace packages ship TypeScript sources rather than build output, so the
  // app compiles them. One fewer build step per package, and the app's own
  // compiler settings apply uniformly.
  transpilePackages: [
    '@xenon/applications',
    '@xenon/auth',
    '@xenon/config',
    '@xenon/contracts',
    '@xenon/core',
    '@xenon/database',
    '@xenon/discord',
    '@xenon/domain',
    '@xenon/fivem',
    '@xenon/jobs',
    '@xenon/logger',
    '@xenon/notifications',
    '@xenon/permissions',
    '@xenon/storage',
    '@xenon/ui',
    '@xenon/validation',
  ],

  // discord.js is reached through @xenon/discord's shared embed builders; its
  // optional native codecs (zlib-sync, bufferutil) cannot be bundled.
  serverExternalPackages: [
    '@prisma/client',
    'bullmq',
    'discord.js',
    'ioredis',
    'pino',
    'pino-pretty',
  ],

  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.discordapp.com' },
      { protocol: 'https', hostname: 'media.discordapp.net' },
      ...(mediaImagePatterns() ?? []),
    ],
  },

  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy(isDev) },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          ...(isDev
            ? []
            : [
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=63072000; includeSubDomains; preload',
                },
              ]),
        ],
      },
    ];
  },
};

export default nextConfig;
