import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cliError, control, project } from './common.mjs';
import { waitForStatus } from './update-flow.mjs';
import { missedSamplingWindow } from './monitoring.mjs';

try {
  const arguments_ = process.argv.slice(2);
  const option = (name, fallback) => arguments_.includes(name) ? Number(arguments_[arguments_.indexOf(name) + 1]) : fallback;
  const seconds = option('--seconds', 86400);
  const interval = option('--interval', 60);
  const quiet = option('--quiet-seconds', 960);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 172800 || !Number.isFinite(interval) || interval < 10 || !Number.isFinite(quiet) || quiet < 0) throw new Error('Invalid soak duration or interval.');
  const initial = await control('/status');
  if (!initial.running) throw new Error('Start the hosted bot before monitoring.');
  await waitForStatus(control, status => status.ready && status.lastAckAt > 0, 150_000, 'the first heartbeat acknowledgement');
  const file = resolve(project, 'data', 'cloudflare-soak-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  const started = Date.now();
  const report = { startedAt: new Date(started).toISOString(), requiredSeconds: seconds, initialQuietSeconds: Math.min(quiet, seconds), complete: false, samples: [] };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(report), { mode: 0o600, flag: 'wx' });
  console.log('Monitoring status. Report: ' + file);
  let previousAt, expectedDelayMs = 0;
  do {
    const at = Date.now();
    try {
      const status = await control('/status');
      report.samples.push({ at: new Date(at).toISOString(), healthy: status.ready === true && status.running === true && !status.blocked && at - status.lastAckAt < 120_000,
        running: status.running, ready: status.ready, blocked: status.blocked, lastAckAt: status.lastAckAt, connections: status.connections });
    } catch { report.samples.push({ at: new Date(at).toISOString(), healthy: false, error: 'Control request failed.' }); }
    if (missedSamplingWindow(previousAt, at, expectedDelayMs)) {
      report.samples.at(-1).healthy = false;
      report.samples.at(-1).error = 'Sampling gap: the monitoring machine may have slept or lost connectivity.';
    }
    previousAt = at;
    await writeFile(file, JSON.stringify(report), { mode: 0o600 });
    if (Date.now() - started >= seconds * 1000) break;
    const nextDelay = report.samples.length === 1 ? Math.max(interval, quiet) : interval;
    expectedDelayMs = Math.min(nextDelay * 1000, started + seconds * 1000 - Date.now());
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expectedDelayMs)));
  } while (true);
  report.complete = true;
  report.passed = report.samples.every(sample => sample.healthy);
  report.completedAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(report), { mode: 0o600 });
  console.log(`Soak ${report.passed ? 'passed' : 'found unhealthy samples'}. Inspect ${file} and Cloudflare usage metrics.`);
  if (!report.passed) process.exitCode = 1;
} catch (error) { cliError(error); }
