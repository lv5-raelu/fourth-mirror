import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stringify } from 'devalue';
import { BetaClient, parseDetails, parseFeed } from '../src/beta/source.ts';
import { BetaMonitor, BETA_POLL_MS } from '../src/beta/monitor.ts';
import type { BetaAlertState, BetaStateStore } from '../src/beta/types.ts';
import { latestMessage } from '../src/beta/presentation.ts';
import { betaChannelPermissions } from '../src/beta/permissions.ts';
import { executeBeta } from '../src/beta/feature.ts';

const guild = '323456789012345678', channel = '333456789012345678';
const page = (value: unknown) => JSON.stringify({ type: 'data', nodes: [{ type: 'data', data: JSON.parse(stringify({ data: value })) }] });
function revision(design = 100, version = '9.0.51') {
  return { revision: { branch: 'beta', version, design_revision: design, resource_revision: 80, design_timestamp: 1_700_000_000 },
    characters: [{ id: 1, name: { text: 'Test <unbreak>Mirror</unbreak>' }, status: 'updated', href: '/characters/1/test-mirror/beta',
      diff: `/diff/characters/1/test-mirror?prev=beta_${version}_99&cur=beta_${version}_${design}` }],
  };
}
const feedBody = (design = 100) => page({ revisions: [revision(design)] });
const diffBody = () => page({ source: { dto: { name: { text: 'Test Mirror', key: 'old-localization' }, hash: 'old', skills: [{ id: 42, name: { text: 'Beam' }, power: 100 }] } },
  target: { dto: { name: { text: 'Test Mirror', key: 'new-localization' }, hash: 'new', skills: [{ id: 42, name: { text: 'Beam' }, power: 120 }] } } });

test('decodes streamed changelogs, keeps same-version revisions distinct, and rejects unexpected sources', () => {
  const initial = JSON.stringify({ type: 'data', nodes: [{ type: 'data', data: JSON.parse(stringify({ streamed: { marker: 'unused' } })) }] });
  const chunk = JSON.stringify({ type: 'chunk', id: 1, data: JSON.parse(stringify({ error: null, data: { revisions: [revision(100), revision(101), revision(100)] } })) });
  const feed = parseFeed(initial + '\n' + chunk, 123);
  assert.equal(feed.revisions.length, 2);
  assert.deepEqual(feed.revisions.map(value => value.revision), [101, 100]);
  assert.equal(feed.revisions[0]?.entities[0]?.name, 'Test Mirror');
  assert.match(feed.revisions[0]!.entities[0]!.diffUrl!, /^https:\/\/hsr\.gachabase\.net\/diff\//);
  const historical = revision(); historical.characters[0]!.href += '/9.0.51/100';
  assert.equal(parseFeed(page({ revisions: [historical] }), 1).revisions[0]?.entities.length, 1);
  const malicious = revision(); malicious.characters[0]!.href = 'https://other.invalid/steal';
  assert.equal(parseFeed(page({ revisions: [malicious] }), 1).revisions[0]?.entities.length, 0);
  assert.throws(() => parseFeed('<html>challenge</html>', 1));
  assert.throws(() => parseFeed(page({ revisions: [] }), 1), /No valid/);
});

test('extracts real before/after changes without treating asset or localization hashes as balance changes', () => {
  const details = parseDetails(diffBody());
  assert.deepEqual(details.changes, [{ field: 'skills[id=42].power', before: '100', after: '120' }]);
  assert.ok(details.current.some(value => value.field === 'skills[id=42].name.text' && value.value === 'Beam'));
  assert.ok(details.current.every(value => !value.field.includes('hash') && !value.field.endsWith('.key')));
});

test('coalesces cached reads, keeps stale data on an outage, and queries only matching entities on the fixed source', async () => {
  let now = 100_000, failing = false;
  const urls: URL[] = [];
  const client = new BetaClient(async input => {
    const url = new URL(String(input)); urls.push(url);
    if (failing) return new Response('Unavailable', { status: 503 });
    return new Response(url.pathname.includes('/diff/') ? diffBody() : feedBody());
  }, () => now);
  await Promise.all([client.feed(), client.feed()]);
  assert.equal(urls.length, 1);
  const result = await client.question('What changed for Test Mirror?');
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => url.origin === 'https://hsr.gachabase.net' && url.searchParams.get('lang') === 'en'));
  const data = JSON.parse(result.source.content);
  assert.equal(data.details[0].changes[0].after, '120');
  await client.question('Test Mirror changes again');
  assert.equal(urls.length, 2);
  now += 6 * 60_000; failing = true;
  assert.equal((await client.feed()).stale, true);
  await assert.rejects(client.feed(true), /unavailable/);
});

function monitorFixture() {
  let now = 100_000, design = 100, failing = false;
  let saved: BetaAlertState | undefined;
  const store: BetaStateStore = { load: async () => saved && structuredClone(saved), save: async value => { saved = structuredClone(value); } };
  const client = new BetaClient(async () => new Response(failing ? 'Bad source' : feedBody(design), { status: failing ? 503 : 200 }), () => now);
  return { client, store, monitor: new BetaMonitor(client, store, guild, () => now), advance: () => { now += BETA_POLL_MS + 1; },
    update: () => { design++; }, fail: (value: boolean) => { failing = value; }, now: () => now };
}

test('notifications start with a baseline, announce new revisions once, survive restart, and ignore source failures', async () => {
  const fixture = monitorFixture();
  const posts: string[] = [];
  const send = async (_channel: string, revisions: { key: string }[]) => { posts.push(revisions[0]!.key); };
  await fixture.monitor.configure(channel);
  await fixture.monitor.check(send);
  assert.equal(posts.length, 0);
  fixture.advance(); fixture.update();
  await Promise.all([fixture.monitor.check(send), fixture.monitor.check(send)]);
  assert.deepEqual(posts, ['beta_9.0.51_101']);
  const restarted = new BetaMonitor(fixture.client, fixture.store, guild, fixture.now);
  fixture.advance(); await restarted.check(send);
  assert.equal(posts.length, 1);
  fixture.advance(); fixture.update(); fixture.fail(true); await restarted.check(send);
  assert.equal((await restarted.status()).checkpoint?.revision, 101);
  assert.match((await restarted.status()).lastError!, /could not be checked/);
  fixture.advance(); fixture.fail(false); await restarted.check(send);
  assert.deepEqual(posts, ['beta_9.0.51_101', 'beta_9.0.51_102']);
  await restarted.configure(null); fixture.advance(); fixture.update(); await restarted.check(send);
  assert.equal(posts.length, 2);
});

test('unconfirmed deliveries are not repeated after restart and a different configured server starts disabled', async () => {
  const fixture = monitorFixture();
  await fixture.monitor.configure(channel);
  fixture.advance(); fixture.update();
  let calls = 0;
  await fixture.monitor.check(async () => { calls++; throw new Error('Uncertain external result'); });
  fixture.advance();
  const restarted = new BetaMonitor(fixture.client, fixture.store, guild, fixture.now);
  await restarted.check(async () => { calls++; });
  assert.equal(calls, 1);
  assert.match((await restarted.status()).lastError!, /could not be delivered/);
  const other = new BetaMonitor(fixture.client, fixture.store, '423456789012345678', fixture.now);
  assert.equal((await other.status()).channelId, null);
});

test('only server managers can configure alerts; validation and source failures leave existing configuration alone', async () => {
  const fixture = monitorFixture();
  let validations = 0;
  const feature = { client: fixture.client, monitor: fixture.monitor };
  const request = { action: 'alerts', userId: '423456789012345678', channelId: channel, canManage: false };
  await assert.rejects(executeBeta(request, feature, null, async () => {}, async () => { validations++; }), /Manage Server/);
  assert.equal(validations, 0);
  await assert.rejects(executeBeta({ ...request, canManage: true }, feature, null, async () => {}, async () => { throw new Error('Wrong channel'); }), /Wrong channel/);
  assert.equal((await fixture.monitor.status()).channelId, null);
  fixture.fail(true);
  await assert.rejects(executeBeta({ ...request, canManage: true }, feature, null, async () => {}, async () => {}), /beta archive/);
  assert.equal((await fixture.monitor.status()).channelId, null);
});

test('notification permissions respect channel role and member overwrites', () => {
  const bot = '423456789012345678', role = '523456789012345678';
  const roles = [{ id: guild, permissions: String(1024n | 2048n) }, { id: role, permissions: '16384' }];
  assert.equal(betaChannelPermissions(guild, bot, [role], roles, []), true);
  assert.equal(betaChannelPermissions(guild, bot, [role], roles, [{ id: role, type: 0, deny: '16384', allow: '0' }]), false);
  assert.equal(betaChannelPermissions(guild, bot, [role], roles, [{ id: guild, type: 0, deny: '2048', allow: '0' }, { id: bot, type: 1, allow: '2048', deny: '0' }]), true);
});

test('latest embeds stay within Discord limits and expose source comparisons without automatic mentions', () => {
  const feed = parseFeed(feedBody(), 100_000);
  const entry = feed.revisions[0]!.entities[0]!;
  feed.revisions[0]!.entities = Array.from({ length: 100 }, (_, index) => ({ ...entry, id: index, name: '@everyone ' + 'x'.repeat(110) }));
  const message = latestMessage(feed);
  const embed = message.embeds[0]!;
  assert.ok(embed.fields!.every(field => field.value.length <= 1024));
  assert.ok(JSON.stringify(embed).length < 6_000);
  assert.ok(!JSON.stringify(embed).includes('@everyone'));
  assert.match(embed.fields![2]!.value, /https:\/\/hsr.gachabase.net/);
});
