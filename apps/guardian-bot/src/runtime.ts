import { guardianEnv } from '@xenon/config/guardian';
import { createLogger, type Logger } from '@xenon/logger';

/**
 * Process-wide runtime services for Xenon Guardian.
 *
 * Guardian never loads the repository's root `.env`: it receives its complete
 * environment from the host, so database, Redis, Auth.js, storage, FiveM and
 * Link/Core values in that file can never reach this process.
 */

export const logger: Logger = createLogger({
  service: 'guardian',
  level: guardianEnv.LOG_LEVEL,
  pretty: false,
});

export { guardianEnv };
