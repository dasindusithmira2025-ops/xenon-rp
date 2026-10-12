import { startGuardianRuntime } from './discord/discord-only';
import { logger } from './runtime';

startGuardianRuntime().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start Xenon Guardian');
  process.exit(1);
});
