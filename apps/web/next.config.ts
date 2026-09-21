// Side-effect import, and it must come first. Next.js reads `.env` relative to
// the app directory, but this monorepo keeps a single `.env` at the root so the
// web tier, the bot and the Prisma CLI cannot drift apart. Loading it here puts
// the values in `process.env` before Next evaluates anything else, which is
// what makes NEXT_PUBLIC_* inlining work during a build.
import '@xenon/config/load-env';

import type { NextConfig } from 'next';

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
    "form-action 'self'",
    // Nothing on this site should ever be framed: the control centre has
    // destructive buttons, and clickjacking is exactly how they get clicked.
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

const isDev = process.env.NODE_ENV !== 'production';

const nextConfig: NextConfig = {
  reactStrictMode: true,

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
    '@xenon/core',
    '@xenon/database',
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

  serverExternalPackages: ['@prisma/client', 'bullmq', 'ioredis', 'pino', 'pino-pretty'],

  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.discordapp.com' },
      { protocol: 'https', hostname: 'media.discordapp.net' },
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
