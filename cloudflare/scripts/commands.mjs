import { REST, Routes } from 'discord.js';
import { commands } from '../../src/commands/index.ts';
import { cliError, validateDiscordSettings } from './common.mjs';

try {
  const body = [...commands.values()].map(command => command.data.toJSON());
  if (process.argv.includes('--dry-run')) console.log(JSON.stringify(body, null, 2));
  else {
    const config = await validateDiscordSettings();
    await new REST({ version: '10' }).setToken(config.token).put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body });
    console.log(`Synced ${body.length} commands to the configured application and server.`);
  }
} catch { cliError(new Error('Command sync failed. Check the staging application ID, token, guild ID, and bot installation.')); }
