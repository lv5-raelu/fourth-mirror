import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'devalue';
import { syncApplicationCommands } from '../src/commands/registration.ts';
import { BetaFileStore } from '../src/beta/file-store.ts';
import { ServerBeta } from '../src/beta/servers.ts';
import { BetaClient } from '../src/beta/source.ts';
import { BETA_POLL_MS } from '../src/beta/monitor.ts';
import type { BetaAlertState } from '../src/beta/types.ts';

const first = '323456789012345678', second = '423456789012345678';
function state(guildId = first): BetaAlertState {
  return { guildId, channelId: '333456789012345678', checkpoint: null, nextCheckAt: 0,
    lastCheckedAt: null, lastAnnouncedAt: null, lastError: null, deliveryPending: false };
}

test('publishes guild-install-only global commands before retiring the old server registry', async () => {
  const calls: { route: string; body: unknown }[] = [];
  const rest = { put: async (route: `/${string}`, options: { body?: unknown } = {}) => { calls.push({ route, body: options.body }); } };
  const config = { applicationId: '123456789012345678', guildId: first };
  await syncApplicationCommands(rest, config);
  assert.deepEqual(calls.map(call => call.route), [`/applications/${config.applicationId}/commands`, `/applications/${config.applicationId}/guilds/${first}/commands`]);
  const body = calls[0]!.body as { name: string; contexts: number[]; integration_types: number[] }[];
  assert.deepEqual(body.map(command => command.name).sort(), ['beta', 'chat', 'help', 'ping', 'reset']);
  assert.ok(body.every(command => JSON.stringify(command.contexts) === '[0]' && JSON.stringify(command.integration_types) === '[0]'));
  assert.deepEqual(calls[1]!.body, []);
  let attempts = 0;
  await assert.rejects(syncApplicationCommands({ put: async () => { attempts++; throw new Error('Unavailable'); } }, config));
  assert.equal(attempts, 1, 'A failed global publish must leave the old guild registry intact');
  calls.length = 0;
  await syncApplicationCommands(rest, { applicationId: config.applicationId });
  assert.equal(calls.length, 1, 'New installations do not require a legacy server ID');
});

test('file settings preserve a legacy server, serialize concurrent writes, and retain independent servers on restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fourth-mirror-beta-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'beta-alerts.json');
  const legacy = { ...state(), deliveryPending: true, nextCheckAt: 12345 };
  await writeFile(path, JSON.stringify(legacy));
  const store = await BetaFileStore.open(path);
  assert.deepEqual(await store.load(first), legacy);
  assert.equal(await store.load(second), undefined);
  await Promise.all([store.save({ ...legacy, channelId: null }), store.save(state(second))]);
  const restarted = await BetaFileStore.open(path);
  assert.equal((await restarted.load(first))?.channelId, null);
  assert.equal((await restarted.load(second))?.channelId, state(second).channelId);
  assert.equal((await restarted.load(first))?.deliveryPending, true);
  assert.equal((await restarted.list()).length, 2);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);
});

test('server alerts use separate baselines, queues, delivery nonces, and enable settings while sharing source reads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fourth-mirror-beta-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'beta-alerts.json');
  let now = 100_000, design = 100, reads = 0;
  const client = new BetaClient(async () => {
    reads++;
    return new Response(JSON.stringify({ type: 'data', nodes: [{ type: 'data', data: JSON.parse(stringify({ data: { revisions: [{
      revision: { branch: 'beta', version: '9.0.51', design_revision: design, resource_revision: 80 },
    }] } })) }] }));
  }, () => now);
  const servers = new ServerBeta(client, await BetaFileStore.open(path), () => now);
  await Promise.all([servers.forGuild(first).monitor.configure('333456789012345678'), servers.forGuild(second).monitor.configure('433456789012345678')]);
  assert.equal(reads, 1);
  now += BETA_POLL_MS + 1; design++;
  const deliveries: { guildId: string; channelId: string; nonce: string }[] = [];
  await servers.check(() => true, async (guildId, channelId, _revisions, _checkedAt, nonce) => {
    deliveries.push({ guildId, channelId, nonce });
    if (guildId === first) throw new Error('First server lost permission');
  });
  assert.equal(reads, 2);
  assert.equal(deliveries.length, 2, 'One server failure must not block another');
  assert.equal(new Set(deliveries.map(delivery => delivery.nonce)).size, 2);
  assert.ok(deliveries.every(delivery => delivery.nonce.length <= 25));
  assert.match((await servers.forGuild(first).monitor.status()).lastError!, /could not be delivered/);
  assert.equal((await servers.forGuild(second).monitor.status()).lastError, null);
  await servers.forGuild(first).monitor.configure(null);
  const restarted = new ServerBeta(client, await BetaFileStore.open(path), () => now);
  now += BETA_POLL_MS + 1; design++;
  await restarted.check(() => true, async guildId => { assert.equal(guildId, second); deliveries.push({ guildId, channelId: '', nonce: '' }); });
  assert.equal(deliveries.length, 3);
  now += BETA_POLL_MS + 1; design++;
  await restarted.check(id => id === first, async () => { assert.fail('Excluded server was polled'); });
  assert.equal(deliveries.length, 3);
  assert.equal(reads, 3);
});
