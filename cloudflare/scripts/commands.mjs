import { REST } from 'discord.js';
import { globalCommandBody, syncApplicationCommands } from '../../src/commands/registration.ts';
import { cliError, validateDiscordSettings } from './common.mjs';

try {
  const body = globalCommandBody();
  if (process.argv.includes('--dry-run')) console.log(JSON.stringify(body, null, 2));
  else {
    const config = await validateDiscordSettings();
    await syncApplicationCommands(new REST({ version: '10' }).setToken(config.token), config);
    console.log(`Synced ${body.length} global commands for installed servers; removed legacy server commands if configured.`);
  }
} catch { cliError(new Error('Command sync failed. Check the selected application ID, token, and bot installation.')); }
