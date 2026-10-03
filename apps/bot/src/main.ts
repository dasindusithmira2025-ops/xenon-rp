import { botEnv, logger } from './runtime';

async function start(): Promise<void> {
  if (botEnv.BOT_RUNTIME_MODE === 'discord-only') {
    const runtime = await import('./discord/discord-only.js');
    await runtime.startDiscordOnlyRuntime();
    return;
  }

  await import('./integrated-main.js');
}

start().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start Xenon bot');
  process.exit(1);
});
