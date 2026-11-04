import { cliError, control, settings, wrangler } from './common.mjs';
try {
  if (settings.CLOUDFLARE_WORKER_NAME && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(settings.CLOUDFLARE_WORKER_NAME)) throw new Error('Invalid CLOUDFLARE_WORKER_NAME.');
  if (!process.argv.includes('--dry-run') && settings.CLOUDFLARE_BOT_URL) {
    const status = await control('/status');
    if (status.running || status.active) throw new Error('Use cloudflare:update for a running bot; it drains active work before deployment.');
  }
  await wrangler(['deploy', ...(process.argv.includes('--dry-run') ? ['--dry-run'] : [])]);
} catch (error) { cliError(error); }
