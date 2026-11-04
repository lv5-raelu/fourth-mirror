import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { cliError, control, project, saveHistory, settings, wrangler } from './common.mjs';
import { performUpdate } from './update-flow.mjs';
import { isCurrentMain, validateCiDeployment } from './ci.mjs';
import { saveEncryptedHistory } from './backup.mjs';

try {
  const ci = process.argv.includes('--ci');
  if (ci) {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' });
    validateCiDeployment(settings, head.status === 0 ? head.stdout.trim() : '');
    const current = await isCurrentMain(settings, async repository => {
      const result = spawnSync('gh', ['api', `repos/${repository}/git/ref/heads/main`, '--jq', '.object.sha'], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: settings.GH_TOKEN } });
      if (result.status !== 0) throw new Error('Could not verify main before deployment.');
      return result.stdout;
    });
    if (!current) { console.log('Skipped deployment because a newer commit is already on main.'); process.exit(0); }
  }
  await performUpdate({
    check: async () => {
      if (ci) return; // validateCiDeployment ties this checkout to the successful checks job.
      const checks = spawnSync('npm', ['run', 'cloudflare:check'], { cwd: project, stdio: 'inherit' });
      if (checks.status !== 0) throw new Error('Update checks failed; the hosted bot was not changed.');
    },
    access: () => wrangler(['deployments', 'list'], { capture: true }),
    control,
    backup: async history => {
      const name = 'cloudflare-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      if (ci) {
        await saveEncryptedHistory(resolve(settings.CLOUDFLARE_BACKUP_DIR, name + '.enc'), history, settings.HISTORY_BACKUP_PUBLIC_KEY);
        console.log('Saved an encrypted history backup before deployment.');
      } else {
        await saveHistory(resolve(project, 'data/backups', name), history);
        console.log('Saved a private history backup before deployment.');
      }
    },
    deploy: () => wrangler(['deploy', '--durable-objects-code-update-mode', 'immediate']), report: message => console.error(message),
  });
  console.log('Updated; the Gateway is ready and heartbeats are acknowledged.');
} catch (error) { cliError(error); }
