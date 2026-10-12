import { coreApiEnv } from '@xenon/config/core-api';
import { createLogger, type Logger } from '@xenon/logger';

// Development shares the repository's root .env. Production receives its
// complete environment from the host. Dynamic because the file is loaded
// conditionally; `coreApiEnv` is lazy, so it is first read below, after the
// file (if any) has been applied.
// eslint-disable-next-line no-restricted-properties -- intentional pre-config bootstrap read
if (process.env.NODE_ENV !== 'production') {
  await import('@xenon/config/load-env');
}

export const logger: Logger = createLogger({
  service: 'core-api',
  level: coreApiEnv.LOG_LEVEL,
  pretty: coreApiEnv.NODE_ENV !== 'production',
});

export { coreApiEnv };
