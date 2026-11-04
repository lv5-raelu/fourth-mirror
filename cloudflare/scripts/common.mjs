import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHistory } from '../../src/chat/history.ts';
import { parseConfig } from '../../src/config-values.ts';

export const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const settingsPath = resolve(project, process.env.CLOUDFLARE_SETTINGS_FILE || '.env.cloudflare');
export const settings = { ...process.env, ...parseEnv(await readFile(settingsPath, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
})) };
export const secretNames = ['ADMIN_TOKEN', 'DISCORD_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID',
  'AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL', 'AI_TOKEN_LIMIT_PARAM', 'AI_MAX_OUTPUT_TOKENS', 'AI_REASONING_EFFORT', 'AI_LORE_TOOLS', 'AI_VISION_ENABLED', 'AI_SYSTEM_PROMPT', 'WEB_API_KEY', 'WEB_BASE_URL'];

export async function validateDiscordSettings() {
  const config = parseConfig(settings, () => settings.AI_SYSTEM_PROMPT?.trim() || 'Bundled Fourth Mirror persona.');
  if (settings.CLOUDFLARE_WORKER_NAME?.endsWith('-staging')) {
    const existing = parseEnv(await readFile(resolve(project, '.env'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }));
    if ((existing.DISCORD_TOKEN && existing.DISCORD_TOKEN === settings.DISCORD_TOKEN) ||
      (existing.DISCORD_APPLICATION_ID && existing.DISCORD_APPLICATION_ID === settings.DISCORD_APPLICATION_ID)) {
      throw new Error('Staging needs a separate Discord application. The current bot credentials were not used.');
    }
  }
  return config;
}

export async function wrangler(args, { input, capture = false } = {}) {
  const command = [resolve(project, 'node_modules/wrangler/bin/wrangler.js'), ...args,
    '--config', resolve(project, 'cloudflare/wrangler.jsonc'),
    ...(settings.CLOUDFLARE_WORKER_NAME ? ['--name', settings.CLOUDFLARE_WORKER_NAME] : [])];
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, command, { cwd: project,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
    let output = '';
    if (capture) { child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); }
    if (input !== undefined) { child.stdin.on('error', reject); child.stdin.end(input); }
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveResult(output) : reject(new Error('Wrangler command failed. Check Cloudflare login and the command output.')));
  });
}

function controlUrl(path) {
  const url = new URL(settings.CLOUDFLARE_BOT_URL || 'https://configure-CLOUDFLARE_BOT_URL.invalid');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.hostname.endsWith('.invalid')) {
    throw new Error('Set CLOUDFLARE_BOT_URL to the HTTPS Worker URL in .env.cloudflare.');
  }
  if (settings.CLOUDFLARE_WORKER_NAME && url.hostname.endsWith('.workers.dev') && url.hostname.split('.')[0] !== settings.CLOUDFLARE_WORKER_NAME) {
    throw new Error('CLOUDFLARE_BOT_URL does not match CLOUDFLARE_WORKER_NAME. Refusing to control a different deployment.');
  }
  if (!settings.ADMIN_TOKEN || settings.ADMIN_TOKEN.length < 32) throw new Error('Set ADMIN_TOKEN in .env.cloudflare.');
  url.pathname = path;
  return url;
}

export async function control(path, method = 'GET', body) {
  const response = await fetch(controlUrl(path), { method,
    headers: { Authorization: 'Bearer ' + settings.ADMIN_TOKEN, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual', signal: AbortSignal.timeout(125_000) });
  if (!response.ok) {
    // No response bodies or upstream diagnostics in CLI errors: they may include private history.
    await response.body?.cancel();
    throw new Error(`Bot control returned HTTP ${response.status}. Check the Worker URL, admin token, and configuration.`);
  }
  return response.json();
}

export async function saveHistory(file, data) {
  const validated = parseHistory(data);
  await mkdir(dirname(resolve(file)), { recursive: true, mode: 0o700 });
  await writeFile(resolve(file), JSON.stringify(validated), { mode: 0o600, flag: 'wx' });
  return validated.sessions.length;
}

export function cliError(error) {
  console.error(error instanceof Error && error.message === 'fetch failed'
    ? `Could not reach the Worker (${error.cause?.code || 'network error'}). Check CLOUDFLARE_BOT_URL and HTTPS reachability; a new workers.dev hostname may still be provisioning.`
    : error instanceof Error ? error.message : 'Cloudflare operation failed.');
  if (error instanceof Error && error.message.startsWith('Invalid configuration:')) console.error('Update the selected Cloudflare settings file: ' + settingsPath);
  process.exitCode = 1;
}
