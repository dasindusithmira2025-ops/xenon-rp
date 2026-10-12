import { linkEnv } from '@xenon/config/link';
import { createLogger, type Logger } from '@xenon/logger';

// Development shares the repository's root .env. Production receives its
// complete environment from the host and must never pick up unrelated
// database, Redis or Guardian values from a file on disk. Dynamic because the
// file is loaded conditionally; `linkEnv` is lazy, so it is first read below,
// after the file (if any) has been applied.
// eslint-disable-next-line no-restricted-properties -- intentional pre-config bootstrap read
if (process.env.NODE_ENV !== 'production') {
  await import('@xenon/config/load-env');
}

export const logger: Logger = createLogger({
  service: 'link',
  level: linkEnv.LOG_LEVEL,
  pretty: linkEnv.NODE_ENV !== 'production',
});

export { linkEnv };
