import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { project, settingsPath, cliError } from './common.mjs';
import { envValue } from './env.mjs';

try {
  const original = process.argv.includes('--copy-providers') ? parseEnv(await readFile(resolve(project, '.env'), 'utf8')) : {};
  const values = {
    CLOUDFLARE_WORKER_NAME: 'fourth-mirror-staging', CLOUDFLARE_BOT_URL: '',
    ADMIN_TOKEN: randomBytes(32).toString('hex'), DISCORD_TOKEN: '', DISCORD_APPLICATION_ID: '', DISCORD_GUILD_ID: original.DISCORD_GUILD_ID || '',
  };
  for (const name of ['AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL', 'AI_TOKEN_LIMIT_PARAM', 'AI_MAX_OUTPUT_TOKENS', 'AI_REASONING_EFFORT', 'AI_LORE_TOOLS', 'AI_VISION_ENABLED', 'AI_SYSTEM_PROMPT', 'WEB_API_KEY', 'WEB_BASE_URL']) {
    values[name] = original[name] || '';
  }
  const body = '# Private staging settings. Use a SEPARATE Discord test application.\n# The existing Discord bot token is deliberately not copied.\n' +
    Object.entries(values).map(([key, value]) => key + '=' + envValue(key, value)).join('\n') + '\n';
  await writeFile(settingsPath, body, { mode: 0o600, flag: 'wx' });
  console.log('Created .env.cloudflare with a new admin secret. Fill in the separate test bot token and application ID.');
  if (process.argv.includes('--copy-providers')) console.log('Copied provider settings and the guild ID from .env. The current Discord token was not copied.');
} catch (error) { cliError(error.code === 'EEXIST' ? new Error('Settings already exist; they were not overwritten.') : error); }
