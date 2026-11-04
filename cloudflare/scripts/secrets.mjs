import { cliError, secretNames, settings, validateDiscordSettings, wrangler } from './common.mjs';

try {
  if (!settings.ADMIN_TOKEN || settings.ADMIN_TOKEN.length < 32) throw new Error('ADMIN_TOKEN must have at least 32 characters. Run cloudflare:setup first.');
  const adminOnly = process.argv.includes('--admin-only');
  if (!adminOnly) {
    await validateDiscordSettings();
    for (const name of ['AI_BASE_URL', 'WEB_BASE_URL']) if (settings[name] && new URL(settings[name]).protocol !== 'https:') throw new Error(name + ' must use HTTPS.');
  }
  const values = Object.fromEntries((adminOnly ? ['ADMIN_TOKEN'] : secretNames).map(name => [name, settings[name] || '']));
  for (const [name, value] of Object.entries(values)) if (Buffer.byteLength(value) > 5 * 1024) throw new Error(name + ' exceeds the Workers per-variable limit; bundle large persona text instead.');
  if (process.argv.includes('--dry-run')) console.log('Secret names validated: ' + Object.keys(values).join(', ') + '. Values are not printed.');
  else await wrangler(['secret', 'bulk'], { input: JSON.stringify(values) });
} catch (error) { cliError(error); }
