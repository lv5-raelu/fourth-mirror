import { createBot } from './bot.ts';
import { readConfig } from './config.ts';
import { logger } from './logger.ts';

async function main(): Promise<void> {
  const config = readConfig();
  const client = await createBot(config);
  let stopping = false;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    logger.info(`Shutting down (${reason}).`);

    // Bound shutdown even if a connection or a future background task gets stuck.
    // Unref lets an otherwise idle process exit before the deadline.
    const timeout = setTimeout(() => process.exit(exitCode || 1), 5_000);
    timeout.unref();

    try {
      await client.destroy();
    } catch (error) {
      logger.error('Could not close the Discord connection cleanly.', error);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  process.once('unhandledRejection', (error) => {
    logger.error('Unhandled promise rejection.', error);
    void shutdown('unhandled rejection', 1);
  });

  process.once('uncaughtException', (error) => {
    logger.error('Uncaught exception.', error);
    void shutdown('uncaught exception', 1);
  });

  try {
    await client.login(config.token);
  } catch (error) {
    logger.error('Could not log in. Check the bot token and network connection.', error);
    await shutdown('login failure', 1);
  }
}

main().catch((error: unknown) => {
  logger.error('Could not start the bot.', error);
  process.exitCode = 1;
});
