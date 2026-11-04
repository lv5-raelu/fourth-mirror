import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const directory = dirname(fileURLToPath(import.meta.url));
const project = resolve(directory, '../..');
const temporary = await mkdtemp(join(tmpdir(), 'fourth-mirror-cloudflare-'));
const checks = [];
const record = check => { checks.push(check); console.log(`PASS ${check}`); };
let mf;

function bundle(main, name) {
  const output = join(temporary, name);
  const result = spawnSync(process.execPath, [join(project, 'node_modules/wrangler/bin/wrangler.js'), 'deploy',
    join(directory, main), '--dry-run', '--config', join(directory, 'wrangler.jsonc'), '--outdir', output], {
    cwd: project, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Dry-run build failed:\n${result.stdout}\n${result.stderr}`);
  return join(output, main);
}

async function eventually(check, label) {
  const deadline = Date.now() + 6000;
  let last;
  do {
    last = await check();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

try {
  const main = bundle('worker.js', 'native');
  const bundledModules = readdirSync(dirname(main)).filter(name => name.endsWith('.js') || (name.endsWith('.md') && name !== 'README.md'))
    .map(name => readFileSync(join(dirname(main), name)));
  const uncompressedBytes = bundledModules.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const compressedBytes = bundledModules.reduce((sum, bytes) => sum + gzipSync(bytes).byteLength, 0);
  assert.ok(uncompressedBytes < 64 * 1024 * 1024, 'Bundle exceeds Workers Free 64 MiB uncompressed limit');
  record(`Native bundle: ${(uncompressedBytes / 1024).toFixed(1)} KiB uncompressed, below 64 MiB; ${(compressedBytes / 1024).toFixed(1)} KiB gzip (reference only)`);

  const mock = await readFile(join(directory, 'mock-worker.js'), 'utf8');
  const common = { compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'] };
  function sourceModules(path) {
    const names = readdirSync(dirname(path)).filter(name => name !== basename(path) && name !== 'README.md' && (name.endsWith('.js') || name.endsWith('.md')));
    return [basename(path), ...names].map(name => ({
      path: join(dirname(path), name), type: name.endsWith('.md') ? 'Text' : 'ESModule',
      contents: readFileSync(join(dirname(path), name), 'utf8'),
    }));
  }
  function options(local = true) {
    return convertV4MiniflareOptions({
      resourcePersistencePath: join(temporary, 'state'),
      workers: [
        {
          ...common, name: 'probe', modules: sourceModules(main), modulesRoot: dirname(main),
          bindings: { PROBE_LOCAL: String(local), PROBE_SECRET: 'synthetic-admin-key' },
          durableObjects: { BOT: { className: 'BotProbe', useSQLite: true } }, outboundService: 'mock' },
        { ...common, modules: true, name: 'mock', script: mock,
          durableObjects: { MOCK: { className: 'MockServices', useSQLite: true } },
          outboundService: async () => new Response('External network disabled', { status: 403 }) },
      ],
    });
  }
  mf = new Miniflare(options());
  async function request(path = '/status', body) {
    const worker = await mf.getWorker('probe');
    const response = await worker.fetch(`https://control.probe.invalid${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer synthetic-admin-key', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function control(body) {
    const worker = await mf.getWorker('mock');
    const response = await worker.fetch('https://control.probe.invalid/control', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200);
  }
  async function observations(kind) {
    const worker = await mf.getWorker('mock');
    const response = await worker.fetch('https://control.probe.invalid/observations');
    return (await response.json()).filter(row => row.kind === kind).map(row => row.data);
  }
  const worker = await mf.getWorker('probe');
  const unauthorized = await worker.fetch('https://control.probe.invalid/status');
  assert.equal(unauthorized.status, 401);
  record('Unauthenticated control requests are rejected');

  const ownerId = '123456789012345678';
  const threadId = '223456789012345678';
  const otherOwner = '423456789012345678';
  const otherThread = '523456789012345678';
  const message = { id: '623456789012345678', channel_id: threadId, guild_id: '323456789012345678',
    author: { id: ownerId, bot: false }, content: 'search for synthetic documentation' };
  await request('/create', { ownerId, threadId });
  await request('/start');
  await eventually(async () => (await request()).ready, 'Gateway READY');
  await eventually(async () => (await request()).acks >= 2, 'heartbeat acknowledgements');
  record('Native outbound WebSocket accepts Gateway HELLO, identifies, and receives READY and heartbeat ACKs');

  await control({ message: { ...message, author: { id: otherOwner, bot: false } } });
  await control({ message: { ...message, guild_id: '923456789012345678' } });
  await control({ message });
  await eventually(async () => (await request()).events.find(event => event.id === message.id)?.status === 'complete', 'saved AI reply');
  const deliveries = await observations('delivery');
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].body.content, /https:\/\/example.com\/source/,
    JSON.stringify((await observations('model')).at(-1)?.body.messages.filter(message => message.role === 'tool')));
  assert.deepEqual(deliveries[0].body.allowed_mentions, { parse: [], replied_user: false });
  assert.equal((await observations('search'))[0].authorization, 'Bearer synthetic-web-key');
  assert.equal((await observations('model'))[0].authorization, 'Bearer synthetic-ai-key');
  assert.ok((await observations('model'))[0].body.messages[0].content.includes('Fourth Mirror'));
  record('Existing chat service, OpenAI SDK, persona, web search, citations, mention controls, and SQLite saves work in workerd');

  await control({ message });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await observations('delivery')).length, 1);
  record('Replayed Gateway message IDs do not trigger duplicate provider calls or replies');

  const beforeCrash = (await observations('connection')).length;
  await assert.rejects(worker.fetch('https://control.probe.invalid/crash', {
    headers: { Authorization: 'Bearer synthetic-admin-key' },
  }), /Synthetic crash for recovery testing/);
  // Poll only the mock server: querying the bot itself would wake it and hide a broken alarm.
  await eventually(async () => (await observations('connection')).length > beforeCrash, 'alarm recovery without a bot request');
  await eventually(async () => (await request()).ready, 'resume after eviction');
  assert.equal((await request()).sessions[0].history.length, 2);
  assert.ok((await observations('packet')).some(packet => packet.op === 6 && packet.d.session_id === 'synthetic-session'));
  assert.equal((await observations('connection')).at(-1).host, 'resume.probe.invalid');
  record('A durable alarm recovers a crashed object without incoming bot requests; history survives and Gateway resumes at the saved URL');
  const savedCalls = (await observations('model')).length;
  await control({ message });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await observations('model')).length, savedCalls);
  record('The duplicate-message journal survives an object crash');

  await control({ ack: false });
  await eventually(async () => (await observations('connection')).length >= 3, 'reconnect after missing heartbeat ACK');
  await control({ ack: true });
  await eventually(async () => (await request()).ready && (await request()).acks >= 1, 'healthy heartbeat after reconnect');
  record('Missing heartbeat acknowledgements trigger a reconnect');

  const beforeServerReconnect = (await observations('connection')).length;
  await control({ packet: { op: 7, d: null } });
  await eventually(async () => (await observations('connection')).length > beforeServerReconnect, 'server-requested reconnect');
  await eventually(async () => (await request()).ready, 'resume after server reconnect');
  const identifies = (await observations('packet')).filter(packet => packet.op === 2).length;
  await control({ close: 4007 });
  await eventually(async () => (await observations('packet')).filter(packet => packet.op === 2).length > identifies, 'fresh identify after stale session');
  await eventually(async () => (await request()).ready, 'ready after stale session');
  record('Gateway reconnect requests resume; an invalid sequence discards the stale session and identifies again');

  const slowOwner = '823456789012345678';
  const slowThread = '923456789012345678';
  const slowId = '133456789012345678';
  const slowMessage = { ...message, id: slowId, channel_id: slowThread, author: { id: slowOwner }, content: 'slow synthetic turn' };
  await request('/create', { ownerId: slowOwner, threadId: slowThread });
  await control({ mode: 'slow-model', message: slowMessage });
  await eventually(async () => (await observations('model')).some(call => call.body.messages.at(-1).content === slowMessage.content), 'slow model started');
  const callsBeforeInterruption = (await observations('model')).length;
  await assert.rejects((await mf.getWorker('probe')).fetch('https://control.probe.invalid/crash', {
    headers: { Authorization: 'Bearer synthetic-admin-key' },
  }), /Synthetic crash for recovery testing/);
  await eventually(async () => (await request()).ready, 'resume after interrupting a turn');
  await control({ mode: 'normal', message: slowMessage });
  await new Promise(resolve => setTimeout(resolve, 700));
  const interrupted = await request();
  assert.equal(interrupted.events.find(event => event.id === slowId).status, 'pending');
  assert.equal(interrupted.sessions.find(session => session.threadId === slowThread).history.length, 0);
  assert.equal(interrupted.sessions.find(session => session.threadId === threadId).history.length, 2);
  assert.equal((await observations('model')).length, callsBeforeInterruption);
  assert.equal((await observations('delivery')).length, 1);
  record('A crash during a model request leaves a durable pending record and does not automatically repeat the paid call or deliver an abandoned reply');

  await request('/create', { ownerId: otherOwner, threadId: otherThread });
  await control({ mode: 'model-failure', message: { ...message, id: '723456789012345678', channel_id: otherThread,
    author: { id: otherOwner, bot: false }, content: 'synthetic failure' } });
  await eventually(async () => (await request()).events.find(event => event.id === '723456789012345678')?.status === 'failed', 'provider failure');
  assert.equal((await request()).sessions.find(session => session.threadId === otherThread).history.length, 0);
  record('Provider failure leaves the saved conversation unchanged');
  await control({ mode: 'normal' });

  await control({ close: 4014 });
  await eventually(async () => (await request()).blocked === 4014, 'fatal intents error');
  const connections = (await observations('connection')).length;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await observations('connection')).length, connections);
  record('Fatal Discord intent errors stop reconnecting instead of consuming session starts indefinitely');

  await request('/reset', { ownerId, threadId });
  await request('/stop');
  await mf.dispose();
  mf = new Miniflare(options());
  assert.equal((await request()).sessions.find(session => session.threadId === threadId).history.length, 0);
  assert.equal((await request()).ready, false);
  record('Full local runtime replacement preserves reset history and stopped state');

  await mf.dispose();
  mf = new Miniflare(options(false));
  const disabled = await (await mf.getWorker('probe')).fetch('https://control.probe.invalid/start');
  assert.equal(disabled.status, 503);
  record('The probe refuses to run with its deploy-time default settings');

  console.log(`Local feasibility checks passed: ${checks.length}. No real credentials or external service calls were used.`);
} finally {
  await mf?.dispose();
  await rm(temporary, { recursive: true, force: true });
}
