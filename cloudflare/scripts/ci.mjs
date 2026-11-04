import { backupPublicKey } from './backup.mjs';

export function validateCiDeployment(env, checkedOutSha) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('CI deployment is allowed only for main pushes or manual main runs in GitHub Actions.');
  }
  if (!/^[a-f0-9]{40}$/.test(checkedOutSha) || checkedOutSha !== env.GITHUB_SHA || checkedOutSha !== env.CI_CHECKED_SHA) {
    throw new Error('CI deployment requires the exact commit that passed the checks job.');
  }
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKER_NAME', 'CLOUDFLARE_BOT_URL', 'ADMIN_TOKEN', 'HISTORY_BACKUP_PUBLIC_KEY', 'CLOUDFLARE_BACKUP_DIR', 'GH_TOKEN']) {
    if (!env[name]?.trim()) throw new Error('Missing CI setting: ' + name + '. Configure the GitHub production environment before deploying.');
  }
  if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID) || !/^[\w-]+$/.test(env.CLOUDFLARE_WORKER_NAME) || env.ADMIN_TOKEN.length < 32) throw new Error('Invalid CI deployment settings.');
  const url = new URL(env.CLOUDFLARE_BOT_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.hostname.endsWith('.workers.dev') && url.hostname.split('.')[0] !== env.CLOUDFLARE_WORKER_NAME)) throw new Error('Invalid CI bot URL or Worker name.');
  backupPublicKey(env.HISTORY_BACKUP_PUBLIC_KEY);
}

export async function isCurrentMain(env, readHead) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') || ['.', '..'].includes(env.GITHUB_REPOSITORY.split('/')[1])) throw new Error('Invalid GitHub repository setting.');
  const latest = (await readHead(env.GITHUB_REPOSITORY)).trim();
  if (!/^[a-f0-9]{40}$/.test(latest)) throw new Error('Could not verify the current main commit.');
  return latest === env.GITHUB_SHA;
}
