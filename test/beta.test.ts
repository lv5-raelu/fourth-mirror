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
  assert.deepEqual(data.details[0].descriptionChanges, []);
  assert.deepEqual(data.details[0].currentDescriptions, []);
  assert.ok(!('changes' in data.details[0]) && !('current' in data.details[0]));
  await client.question('Test Mirror changes again');
  assert.equal(urls.length, 2);
  now += 6 * 60_000; failing = true;
  assert.equal((await client.feed()).stale, true);
  await assert.rejects(client.feed(true), /unavailable/);
});

test('questions use resolved, named descriptions for every category without raw paths, arrays, IDs, or metadata deltas', async () => {
  const params = (power: number) => [{ index: 0, values: [power, 0.987654321] }];
  const ability = (power: number) => ({ id: 987654321, name: { text: 'Beam' }, type: { text: 'Skill' },
    description: { text: 'Deals <color=#f29e38ff>#1[i]%</color> DMG.' }, description_params: params(power), internal_multiplier: power * 999 });
  const effect = (power: number) => ({ name: { text: 'Effect' }, description: { text: 'Gain #1[i]% ATK.' }, description_params: params(power) });
  const bonuses = (power: number) => ({ set_bonuses: [{ pieces: 2, ...effect(power) }] });
  const examples = [
    { key: 'characters', path: 'characters', dto: (power: number) => ({ skills: [ability(power)],
      global_passives: [ability(power)], memosprite: { skills: [ability(power)] },
      skill_tree: [{ id: 987654321, levels: [effect(power)] }], eidolons: [{ id: 987654321, level: 1, ...effect(power) }] }) },
    { key: 'lightcones', path: 'lightcones', dto: (power: number) => ({ superimpositions: effect(power) }) },
    { key: 'relics', path: 'relics', dto: bonuses },
    { key: 'planarOrnaments', path: 'planar-ornaments', dto: bonuses },
    { key: 'items', path: 'items', dto: (power: number) => ({ description: { text: 'Restore #1[i]% HP.' }, description_params: params(power) }) },
  ];
  for (const example of examples) {
    const feed = page({ revisions: [{ revision: revision().revision, [example.key]: [{ id: 1, name: { text: 'Test Mirror' }, status: 'updated',
      href: `/${example.path}/1/test-mirror/beta`, diff: `/diff/${example.path}/1/test-mirror?prev=beta_9.0.51_99&cur=beta_9.0.51_100` }] }] });
    const comparison = page({ source: { dto: { ...example.dto(0.1), rarity: 4, max_energy: 100, debug_values: ['BEFORE_RAW_SENTINEL'] } },
      target: { dto: { ...example.dto(0.2), rarity: 5, max_energy: 200, debug_values: ['AFTER_RAW_SENTINEL'] } } });
    const client = new BetaClient(async input => new Response(new URL(String(input)).pathname.includes('/changelog/') ? feed : comparison));
    const result = await client.question('What changed for Test Mirror?');
    const detail = JSON.parse(result.source.content).details[0];
    assert.ok(detail.descriptionChanges.length > 0, example.key);
    assert.ok(detail.descriptionChanges.every((change: { name: string; before: string; after: string }) => change.name && /10%/.test(change.before) && /20%/.test(change.after)));
    assert.ok(detail.currentDescriptions.length > 0, example.key);
    assert.ok(detail.currentDescriptions.every((entry: { name: string; description: string }) => entry.name && /20%/.test(entry.description)));
    assert.ok(!('changes' in detail) && !('current' in detail));
    assert.doesNotMatch(result.source.content, /RAW_SENTINEL|description_params|internal_multiplier|987654321|\[id=|"field"|Max Energy|Rarity/);
  }
});

test('questions omit higher-level and raw-only changes even when browsing uses the raw comparison fallback', async () => {
  const dto = (higher: number) => ({ skills: [{ id: 42, name: { text: 'Beam' }, type: { text: 'Skill' },
    description: { text: 'Deals #1[i]% DMG.' }, description_params: [{ index: 0, values: [0.1, higher] }] }] });
  const comparison = page({ source: { dto: dto(0.987654321) }, target: { dto: dto(0.876543219) } });
  assert.ok(parseDetails(comparison).sections[0]!.entries.some(entry => entry.kind === 'field' && entry.comparison));
  const client = new BetaClient(async input => new Response(new URL(String(input)).pathname.includes('/changelog/') ? feedBody() : comparison));
  const result = await client.question('What changed for Test Mirror?');
  const detail = JSON.parse(result.source.content).details[0];
  assert.deepEqual(detail.descriptionChanges, []);
  assert.deepEqual(detail.currentDescriptions, [{ section: 'Skills & Passives', name: 'Skill · Beam', description: 'Deals 10% DMG.' }]);
  assert.doesNotMatch(result.source.content, /987654321|876543219|description_params|"field"/);
  assert.match(JSON.parse(result.source.content).coverage, /Empty descriptionChanges does not prove the kit is unchanged/);
});

test('question descriptions retain additions and removals and omit unresolved parameter identifiers', async () => {
  const comparison = page({ source: { dto: { skills: [{ id: 42, name: { text: 'Old skill' }, description: { text: 'Old effect.' } }] } },
    target: { dto: { skills: [{ id: 43, name: { text: 'New skill' }, description: { text: 'Gain #3[i] charges.' } }] } } });
  const client = new BetaClient(async input => new Response(new URL(String(input)).pathname.includes('/changelog/') ? feedBody() : comparison));
  const result = await client.question('Test Mirror changes');
  const detail = JSON.parse(result.source.content).details[0];
  assert.deepEqual(detail.descriptionChanges, [{ name: 'Old skill', before: 'Old effect.', after: null },
    { name: 'New skill', before: null, after: 'Gain [not specified] charges.' }]);
  assert.doesNotMatch(result.source.content, /#3\[i\]|parameter 3/);
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

test('latest embeds stay within Discord limits and expose selectors without automatic mentions', () => {
  const feed = parseFeed(feedBody(), 100_000);
  const entry = feed.revisions[0]!.entities[0]!;
  feed.revisions[0]!.entities = Array.from({ length: 100 }, (_, index) => ({ ...entry, id: index, name: '@everyone ' + 'x'.repeat(110) }));
  const message = latestMessage(feed);
  const embed = message.embeds[0]!;
  assert.ok(embed.fields!.every(field => field.value.length <= 1024));
  assert.ok(JSON.stringify(embed).length < 6_000);
  assert.ok(!JSON.stringify(embed).includes('@everyone'));
  assert.ok(message.components!.some(row => row.components.some(component => component.type === 3 && component.options.length <= 25)));
  assert.ok(message.components!.some(row => row.components.some(component => component.type === 2 && component.style === 5 && component.url.startsWith('https://hsr.gachabase.net/'))));
});
