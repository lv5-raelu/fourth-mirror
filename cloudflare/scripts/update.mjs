import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { cliError, control, project, saveHistory, wrangler } from './common.mjs';
import { performUpdate } from './update-flow.mjs';

try {
  await performUpdate({
    check: async () => {
      const checks = spawnSync('npm', ['run', 'cloudflare:check'], { cwd: project, stdio: 'inherit' });
      if (checks.status !== 0) throw new Error('Update checks failed; the hosted bot was not changed.');
    },
    access: () => wrangler(['deployments', 'list'], { capture: true }),
    control,
    backup: async history => {
      const file = resolve(project, 'data/backups', 'cloudflare-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
      await saveHistory(file, history);
      console.log('Saved a private history backup before deployment.');
    },
    deploy: () => wrangler(['deploy', '--durable-objects-code-update-mode', 'immediate']), report: message => console.error(message),
  });
  console.log('Updated; the Gateway is ready and heartbeats are acknowledged.');
} catch (error) { cliError(error); }
