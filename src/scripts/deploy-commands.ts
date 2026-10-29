import { REST, Routes } from 'discord.js';
import { commands } from '../commands/index.ts';
import { readConfig } from '../config.ts';
import { logger } from '../logger.ts';

async function main(): Promise<void> {
  const body = [...commands.values()].map((command) => command.data.toJSON());

  // Preview locally without credentials or any Discord requests.
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const config = readConfig();
  const rest = new REST({ version: '10' }).setToken(config.token);

  logger.info(`Syncing ${body.length} commands to server ${config.guildId}.`);
  await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body });
  logger.info('Server commands synced.');
}

main().catch((error: unknown) => {
  logger.error('Could not sync commands.', error);
  process.exitCode = 1;
});
