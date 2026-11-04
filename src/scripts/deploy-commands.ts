import { REST } from 'discord.js';
import { globalCommandBody, syncApplicationCommands } from '../commands/registration.ts';
import { readConfig } from '../config.ts';
import { logger } from '../logger.ts';

async function main(): Promise<void> {
  const body = globalCommandBody();

  // Preview locally without credentials or any Discord requests.
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const config = readConfig();
  const rest = new REST({ version: '10' }).setToken(config.token);

  logger.info(`Syncing ${body.length} global commands for installed servers.`);
  await syncApplicationCommands(rest, config);
  logger.info('Global commands synced; legacy server commands removed if configured.');
}

main().catch((error: unknown) => {
  logger.error('Could not sync commands.', error);
  process.exitCode = 1;
});
