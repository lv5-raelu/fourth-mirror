import { createBot } from './bot.ts';
import { readConfig } from './config.ts';
import { logger } from './logger.ts';

async function main(): Promise<void> {
  const config = readConfig();
  const bot = await createBot(config);
  let stopping = false;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (stopping) {
      if (exitCode) process.exitCode = exitCode;
      return;
    }
    stopping = true;
    process.exitCode = exitCode;
    logger.info(`Shutting down (${reason}).`);

    // Allow the 90-second web-enabled turn plus delivery and history writes.
    // The host's 120-second shutdown grace period must exceed this deadline.
    const timeout = setTimeout(() => {
      logger.error('Shutdown exceeded 115 seconds; forcing exit.');
      process.exit(1);
    }, 115_000);
    timeout.unref();

    try {
      await bot.stop();
    } catch (error) {
      logger.error('Could not finish pending work and close the Discord connection cleanly.', error);
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
    await bot.client.login(config.token);
  } catch (error) {
    logger.error('Could not log in. Check the bot token and network connection.', error);
    await shutdown('login failure', 1);
  }
}

main().catch((error: unknown) => {
  logger.error('Could not start the bot.', error);
  process.exitCode = 1;
});
