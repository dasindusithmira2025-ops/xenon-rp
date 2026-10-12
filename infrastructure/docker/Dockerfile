# syntax=docker/dockerfile:1.7
#
# One Dockerfile, one image per service. Build from the repository root:
#
#   docker build -f infrastructure/docker/Dockerfile --build-arg APP=guardian-bot -t xenon/guardian .
#   docker build -f infrastructure/docker/Dockerfile --build-arg APP=link-bot     -t xenon/link .
#   docker build -f infrastructure/docker/Dockerfile --build-arg APP=core-api     -t xenon/core-api .
#   docker build -f infrastructure/docker/Dockerfile --build-arg APP=worker       -t xenon/worker .
#   docker build -f infrastructure/docker/Dockerfile --target web                 -t xenon/web .
#   docker build -f infrastructure/docker/Dockerfile --target tools               -t xenon/tools .
#
# The image keeps the workspace layout (/repo/apps/<app>) on purpose: Guardian
# resolves `.data/discord-runtime.json` relative to the workspace root, exactly
# as it does on the current bare-metal deployment, so its persisted security
# state moves between hosts without a path migration.
#
# No secret is ever passed as a build argument or copied into a layer
# (.dockerignore excludes every .env file). Each service receives its own env
# file at run time.

ARG NODE_VERSION=24.21.0

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_HOME=/corepack \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1
# pnpm is fetched once at build time so the unprivileged runtime user never
# needs network access to run it.
RUN corepack enable && corepack prepare pnpm@10.26.2 --activate && chmod -R a+rX /corepack
WORKDIR /repo

# --- Dependencies + Prisma client (shared by every target) ------------------
FROM base AS deps
COPY . .
# `prisma generate` only needs a syntactically valid URL to load its config; it
# never connects. The real DATABASE_URL arrives at run time.
RUN pnpm install --frozen-lockfile \
 && DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build pnpm db:generate

# --- Website -----------------------------------------------------------------
FROM deps AS web
# NEXT_PUBLIC_* values (and the R2 image host) are inlined at build time.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ARG R2_PUBLIC_URL
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=${NEXT_PUBLIC_TURNSTILE_SITE_KEY} \
    R2_PUBLIC_URL=${R2_PUBLIC_URL}
RUN pnpm --filter @xenon/web build && chown -R node:node /repo/apps/web/.next
ENV NODE_ENV=production
WORKDIR /repo/apps/web
USER node
EXPOSE 3200
CMD ["pnpm", "start"]

# --- One-off tasks: migrations, seed, command registration -------------------
FROM deps AS tools
ENV NODE_ENV=production
USER node
CMD ["pnpm", "db:deploy"]

# --- Node services -----------------------------------------------------------
FROM deps AS service-build
ARG APP
RUN test -n "$APP" || (echo "Pass --build-arg APP=<guardian-bot|link-bot|core-api|worker>" && exit 1)
RUN pnpm --filter "@xenon/${APP}" build

FROM service-build AS service
ARG APP
ENV NODE_ENV=production \
    XENON_APP=${APP}
# Guardian's runtime store; mounted as a volume for guardian-bot, unused otherwise.
RUN mkdir -p /repo/.data && chown -R node:node /repo/.data
WORKDIR /repo/apps/${APP}
USER node
CMD ["node", "dist/main.js"]
