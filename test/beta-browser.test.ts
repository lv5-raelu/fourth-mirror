import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stringify } from 'devalue';
import { MessageFlagsBitField, PermissionsBitField } from 'discord.js';
import type { MessageComponentInteraction } from 'discord.js';
import { BetaClient, parseDetails, parseFeed } from '../src/beta/source.ts';
import { browseMessage, detailPages, overviewMessage, sharedMessage } from '../src/beta/browser.ts';
import { readView, viewId } from '../src/beta/navigation.ts';
import { renderDescription } from '../src/beta/details.ts';
import { answerMessage, latestMessage } from '../src/beta/presentation.ts';
import { handleBetaComponent } from '../src/events/interaction-create.ts';
import type { BetaMessage, BetaRow } from '../src/beta/types.ts';
import type { BotContext } from '../src/types.ts';

const page = (value: unknown) => JSON.stringify({ type: 'data', nodes: [{ type: 'data', data: JSON.parse(stringify({ data: value })) }] });
const revision = (design = 100, count = 1, status = 'updated') => ({
  revision: { branch: 'beta', version: '9.0.51', design_revision: design, resource_revision: 80 },
  characters: Array.from({ length: count }, (_, id) => ({ id, name: { text: `Mirror ${id}` }, status, href: `/characters/${id}/mirror/beta`,
    ...(status === 'updated' ? { diff: `/diff/characters/${id}/mirror?prev=beta_9.0.51_99&cur=beta_9.0.51_${design}` } : {}) })),
});
function dto(power: number, tail = '') {
  return { skills: [{ id: 42, name: { text: 'Beam' }, type: { text: 'Skill' }, description: { text: 'Deals <color=orange>#1[f1]%</color> DMG. ' + tail },
    description_params: [{ index: 0, values: [power, power * 2] }] }],
    skill_tree: [{ id: 1, levels: [{ name: { text: 'Polish' }, description: { text: 'Gain #1[i]% SPD.' }, description_params: [{ index: 0, values: [0.1] }] }] }],
    eidolons: [{ id: 1, level: 1, name: { text: 'First' }, description: { text: 'Gain #1[i] charge.' }, params: [{ index: 0, values: [2] }] }],
    assets: { portrait: 'Ignored' }, hash: String(power) };
}
const diff = (tail = '') => page({ source: { dto: dto(0.5, tail) }, target: { dto: dto(0.75, tail) },
  sourceIdent: { branch: 'beta', version: '9.0.51', revision: 99 }, targetIdent: { branch: 'beta', version: '9.0.51', revision: 100 } });
function fixture(count = 1, tail = '') {
  const reads: URL[] = [];
  let revisions = [revision(100, count)], failing = false;
  const client = new BetaClient(async input => {
    const url = new URL(String(input)); reads.push(url);
    return failing && url.pathname.includes('/diff/') ? new Response('Unavailable', { status: 503 })
      : new Response(url.pathname.includes('/changelog/') ? page({ revisions }) : diff(tail));
  });
  return { client, reads, setRevisions: (value: typeof revisions) => { revisions = value; }, fail: () => { failing = true; } };
}
const components = (message: BetaMessage) => (message.components ?? []).flatMap<BetaRow['components'][number]>(row => row.components);
const control = (message: BetaMessage, kind: string): string => {
  const component = components(message).find(component => 'custom_id' in component && component.custom_id.endsWith(':' + kind));
  assert.ok(component && 'custom_id' in component);
  return component.custom_id;
};
const state = (message: BetaMessage) => readView(control(message, 'section').replace(/:section$/, ':view'));
function assertLimits(message: BetaMessage): void {
  let length = 0;
  for (const embed of message.embeds) {
    assert.ok(embed.title.length <= 256);
    assert.ok((embed.description?.length ?? 0) <= 4_096);
    assert.ok((embed.fields?.length ?? 0) <= 25);
    length += embed.title.length + (embed.description?.length ?? 0) + embed.footer.text.length;
    for (const field of embed.fields ?? []) {
      assert.ok(field.name.length <= 256); assert.ok(field.value.length > 0 && field.value.length <= 1_024);
      length += field.name.length + field.value.length;
    }
  }
  assert.ok(length <= 6_000, String(length));
  assert.ok((message.components?.length ?? 0) <= 5);
  for (const row of message.components ?? []) for (const component of row.components) {
    if ('custom_id' in component) assert.ok(component.custom_id.length <= 100);
    if (component.type === 3) assert.ok(component.options.length > 0 && component.options.length <= 25);
  }
}

test('renders indexed tooltip percentages without inventing missing values', () => {
  assert.equal(renderDescription({ text: '#1[f1]% and #2[i], then #3[i]%' }, [{ index: 1, values: [5] }, { index: 0, values: [0.125] }]),
    '12.5% and 5, then [parameter 3 unavailable]');
});

test('compiles readable before/after changes, kits, traces, eidolons, Light Cones, and set bonuses', () => {
  const parsed = parseDetails(diff());
  assert.match(parsed.sections[0]!.entries[0]!.value, /Deals 50% DMG[\s\S]*↓[\s\S]*Deals 75% DMG/);
  assert.deepEqual(parsed.sections[0]!.entries[0]!.comparison, { before: 'Deals 50% DMG.', after: 'Deals 75% DMG.',
    beforeEmphasis: [{ start: 6, end: 9 }], afterEmphasis: [{ start: 6, end: 9 }] });
  assert.deepEqual(parsed.sections.map(section => section.id), ['changes', 'kit', 'traces', 'eidolons']);
  assert.ok(!JSON.stringify(parsed.sections).includes('portrait'));
  const added = parseDetails(page({ dto: { ...dto(0.5),
    affinitive_eidolons: [{ id: 5, name: { text: 'Extra' }, description: { text: 'Gain #1[i]%.' }, params: [{ index: 0, values: [0.4] }] }],
    superimpositions: { name: { text: 'Light' }, description: { text: 'Gain #1[i]%.' }, description_params: [{ index: 0, values: [0.2] }] },
    set_bonuses: [{ pieces: 2, description: { text: 'Gain #1[i]%.' }, description_params: [{ index: 0, values: [0.06] }] }],
  } }));
  assert.match(added.sections[0]!.entries[0]!.value, /No before\/after/);
  assert.ok(added.sections.find(section => section.id === 'eidolons')!.entries.some(entry => entry.value === 'Gain 40%.'));
  assert.ok(added.sections.find(section => section.id === 'details')!.entries.some(entry => entry.value === 'Gain 20%.'));
  assert.ok(added.sections.find(section => section.id === 'details')!.entries.some(entry => entry.value === 'Gain 6%.'));
});

test('navigates changed abilities in Gachabase order with one visual page per ability', async () => {
  const ability = (id: number, type: string, name: string) => ({ id, type: { text: type }, name: { text: name },
    description: { text: `Original effect. ${name === 'Opening' ? 'A long ability description. '.repeat(60) : ''}` } });
  const skills = [ability(1, 'Basic ATK', 'Opening'), ability(2, 'Skill', 'Frostbeam'), ability(3, 'Ultimate', 'Nova'),
    ability(4, 'Talent', 'Removed Talent'), ability(7, 'Technique', 'Glide')];
  const enhanced = ability(8, 'Basic ATK', 'Enhanced Opening');
  const memosprite = { skills: [ability(11, 'Memosprite Talent', 'Echo'), ability(12, 'Memosprite Skill', 'Call')] };
  const updated = (skill: ReturnType<typeof ability>) => ({ ...skill, description: { text: skill.description.text.replace('Original', 'Updated') } });
  const source = { dto: { skills, memosprite } };
  const target = { dto: { skills: [...skills.filter(skill => skill.id !== 4).map(updated), enhanced], memosprite: { skills: memosprite.skills.map(updated) } } };
  const comparison = page({ source, target });
  const parsed = parseDetails(comparison);
  const expected = ['Opening', 'Enhanced Opening', 'Frostbeam', 'Nova', 'Removed Talent', 'Glide', 'Call', 'Echo'];
  assert.deepEqual(parsed.sections[0]!.entries.map(entry => entry.heading!.name), expected);
  assert.deepEqual(parsed.sections.find(section => section.id === 'kit')!.entries.map(entry => entry.heading!.name), expected.filter(name => name !== 'Removed Talent'));

  const client = new BetaClient(async input => new Response(new URL(String(input)).pathname.includes('/changelog/')
    ? page({ revisions: [revision()] }) : comparison));
  const overview = await overviewMessage(client, await client.feed());
  const first = await browseMessage(client, control(overview, 'entity'), ['0']);
  assert.match(first.embeds[0]!.description!, /Changes · Page 1\/8/);
  assert.match(first.files![0]!.description, /^Basic ATK · Opening\n/);
  const next = components(first).find(component => component.type === 2 && component.label === 'Next');
  assert.ok(next && 'custom_id' in next);
  const second = await browseMessage(client, next.custom_id);
  assert.match(second.files![0]!.description, /^Basic ATK · Enhanced Opening\n/);

  const { source: grounding } = await client.question('What changed for Mirror 0?');
  const changes = JSON.parse(grounding.content).details[0].descriptionChanges;
  assert.deepEqual(changes.map(({ name }: { name: string }) => name.split(' · ').at(-1)), expected);
});

test('overviews contain real changes and every entity remains reachable across menu pages', async () => {
  const { client, reads } = fixture(43);
  let message = await overviewMessage(client, await client.feed());
  assert.match(JSON.stringify(message.embeds), /Deals 50%.*↓.*Deals 75%/s);
  const values: string[] = [];
  for (let index = 0; index < 3; index++) {
    assertLimits(message);
    const menu = message.components![0]!.components[0]!;
    assert.equal(menu.type, 3);
    if (menu.type === 3) values.push(...menu.options.map(option => option.value));
    if (index < 2) {
      const next = components(message).find(component => component.type === 2 && component.label === 'Next')!;
      assert.ok('custom_id' in next);
      message = await browseMessage(client, next.custom_id);
    }
  }
  assert.equal(new Set(values).size, 43);
  assert.equal(reads.length, 10, 'Feed and three source previews per menu page are cached');
});

test('navigates kits and paginates long descriptions completely within Discord limits', async () => {
  const { client } = fixture(1, 'long text 😀 \\ | '.repeat(800) + 'END OF DESCRIPTION');
  const overview = await overviewMessage(client, await client.feed());
  let message = await browseMessage(client, control(overview, 'entity'), ['0']);
  message = await browseMessage(client, control(message, 'section'), ['kit']);
  assert.match(message.embeds[0]!.description!, /Skills & Passives · Page 1\/1/);
  assert.equal(message.files?.length, 1);
  message = await browseMessage(client, control(message, 'format'), ['text']);
  const output: string[] = [];
  for (let pageIndex = 0; pageIndex < 40; pageIndex++) {
    assertLimits(message); output.push(...message.embeds[0]!.fields!.map(field => field.value));
    const next = components(message).find(component => component.type === 2 && component.label === 'Next');
    if (!next || !('custom_id' in next) || ('disabled' in next && next.disabled)) break;
    assert.equal(readView(next.custom_id).mode, 'text');
    message = await browseMessage(client, next.custom_id);
  }
  assert.ok(output.join('').endsWith('END OF DESCRIPTION'));
  assert.ok(output.join('').includes('Deals 75% DMG.'));
});

test('uses separate section and format dropdowns with persistent selection across details, characters, overviews, and shared controls', async () => {
  const { client } = fixture(2);
  const overview = await overviewMessage(client, await client.feed());
  const visual = await browseMessage(client, control(overview, 'entity'), ['0']);
  assertLimits(visual);
  const section = components(visual).find(component => component.type === 3 && component.custom_id.endsWith(':section'))!;
  assert.ok(section.type === 3);
  assert.deepEqual(section.options.map(option => option.value), ['changes', 'kit', 'traces', 'eidolons']);
  assert.ok(section.options.every(option => !/\(Text\)|Text Comparison|All Changed Values/.test(option.label)));
  assert.doesNotMatch(visual.embeds[0]!.description!, /Descriptions show|selectable text|Amber:|Red:|Green:/);
  assert.ok(visual.files?.length);
  const format = components(visual).find(component => component.type === 3 && component.custom_id.endsWith(':format'))!;
  assert.ok(format.type === 3);
  assert.deepEqual(format.options, [{ label: 'Visual', value: 'visual', default: true }, { label: 'Text', value: 'text', default: false }]);
  assert.ok(!components(visual).some(component => component.type === 2 && /Show text|Show visual/.test(component.label)));

  const text = await browseMessage(client, control(visual, 'format'), ['text']);
  assertLimits(text);
  assert.equal(text.files, undefined); assert.equal(text.embeds[0]!.image, undefined);
  assert.match(text.embeds[0]!.fields![0]!.value, /50%[\s\S]*↓[\s\S]*75%/);
  assert.equal(state(text).mode, 'text');
  const kit = await browseMessage(client, control(text, 'section'), ['kit']);
  assert.equal(kit.embeds[0]!.image, undefined);
  assert.match(kit.embeds[0]!.fields![0]!.value, /75%/);
  const textFormat = components(kit).find(component => component.type === 3 && component.custom_id.endsWith(':format'))!;
  assert.ok(textFormat.type === 3);
  assert.equal(textFormat.options.find(option => option.default)!.value, 'text');
  const publicKit = sharedMessage(kit);
  const kitImage = await browseMessage(client, control(publicKit, 'format'), ['visual']);
  assert.ok(kitImage.files?.length); assertLimits(kitImage);
  assert.equal(state(kitImage).section, 'kit');

  const other = await browseMessage(client, control(kit, 'entity'), ['1']);
  assert.equal(state(other).mode, 'text');
  const back = components(other).find(component => component.type === 2 && component.label === 'Back to overview')!;
  assert.ok('custom_id' in back);
  const returned = await browseMessage(client, back.custom_id);
  const reopened = await browseMessage(client, control(returned, 'entity'), ['0']);
  assert.equal(state(reopened).mode, 'text');
});

test('accepts older controls, validates explicit format selections, and reflects image permission fallback in the dropdown', async () => {
  const { client } = fixture();
  for (const [old, section] of [['text', 'changes'], ['textkit', 'kit'], ['texttrace', 'traces'], ['texteid', 'eidolons']]) {
    const parsed = readView(`beta:beta_9.0.51_100:0:${old}:3:view`);
    assert.equal(parsed.section, section); assert.equal(parsed.mode, 'text');
    assert.equal(readView(viewId(parsed, 'mode')).page, 0);
    assert.equal(readView(viewId(parsed, 'mode')).mode, 'visual');
    assert.equal(readView(viewId(parsed, 'format'), ['text']).mode, 'text', 'Selecting the current format does not toggle it');
    assert.equal(readView(viewId(parsed, 'format'), ['visual']).page, 0);
  }
  const oldValues = await browseMessage(client, 'beta:beta_9.0.51_100:0:values:3:view');
  assert.equal(state(oldValues).section, 'changes');
  const fallback = await browseMessage(client, 'beta:beta_9.0.51_100:0:kit:0:view', [], false);
  assert.equal(fallback.embeds[0]!.image, undefined);
  assert.match(fallback.embeds[0]!.description!, /Attach Files/);
  const format = components(fallback).find(component => component.type === 3 && component.custom_id.endsWith(':format'))!;
  assert.ok(format.type === 3 && format.disabled);
  assert.equal(format.options.find(option => option.default)!.value, 'text');
  assert.equal(state(fallback).mode, 'text');
  assertLimits(fallback);
  assert.throws(() => readView('beta:beta_9.0.51_100:0:kit:0:invalid:mode'));
  for (const values of [[], ['invalid'], ['text', 'visual']]) {
    assert.throws(() => readView('beta:beta_9.0.51_100:0:kit:0:text:format', values), /Choose Visual or Text/);
  }
});

test('omits the raw-values section in every category and redirects its older controls to Changes', async () => {
  const bonuses = (power: number) => ({ set_bonuses: [{ pieces: 2, description: 'Gain #1[i]% ATK.', description_params: [{ index: 0, values: [power] }] }] });
  const examples = [
    { key: 'characters', path: 'characters', dto },
    { key: 'lightcones', path: 'lightcones', dto: (power: number) => ({ superimpositions: { name: 'Effect', description: 'Gain #1[i]% ATK.', description_params: [{ index: 0, values: [power] }] } }) },
    { key: 'relics', path: 'relics', dto: bonuses },
    { key: 'planarOrnaments', path: 'planar-ornaments', dto: bonuses },
    { key: 'items', path: 'items', dto: (power: number) => ({ description: `Restores ${power * 100} HP.` }) },
  ];
  for (const example of examples) {
    const comparison = page({ source: { dto: example.dto(0.1) }, target: { dto: example.dto(0.2) } });
    const parsed = parseDetails(comparison);
    assert.ok(parsed.changes.length > 0);
    assert.ok(parsed.sections.every(section => section.id !== 'values'), example.key);
    const feed = page({ revisions: [{ revision: revision().revision, [example.key]: [{ id: 1, name: { text: 'Fixture' }, status: 'updated',
      href: `/${example.path}/1/fixture/beta`, diff: `/diff/${example.path}/1/fixture?prev=beta_9.0.51_99&cur=beta_9.0.51_100` }] }] });
    const client = new BetaClient(async input => new Response(new URL(String(input)).pathname.includes('/changelog/') ? feed : comparison));
    const message = await browseMessage(client, 'beta:beta_9.0.51_100:0:values:3:text:view');
    assertLimits(message);
    assert.equal(state(message).section, 'changes'); assert.equal(state(message).page, 0); assert.equal(state(message).mode, 'text');
    const section = components(message).find(component => component.type === 3 && component.custom_id.endsWith(':section'))!;
    assert.ok(section.type === 3 && section.options.every(option => option.value !== 'values' && option.label !== 'All Changed Values'), example.key);
  }
});

test('bounds worst-case overview payloads with several categories and long escaped text', async () => {
  const { client } = fixture();
  const feed = await client.feed(), entity = feed.revisions[0]!.entities[0]!;
  feed.revisions[0]!.entities = Array.from({ length: 100 }, (_, index) => ({ ...entity, category: ['Characters', 'Light Cones', 'Cavern Relics', 'Planar Ornaments', 'Items'][index % 5]!,
    name: '@everyone [*|]'.repeat(9).slice(0, 120) }));
  const result = await overviewMessage(client, feed, Array.from({ length: 10 }, () => feed.revisions[0]!));
  assertLimits(result);
  const pages = detailPages([{ name: '😀'.repeat(300), value: '@everyone[*|]'.repeat(1_000) }]);
  for (const fields of pages) assertLimits({ embeds: [{ title: 'Test', color: 1, fields, footer: { text: 'Test' } }] });
});

test('old controls stay on their revision and new entries request a pinned source snapshot', async () => {
  const { client, reads, setRevisions } = fixture();
  const overview = await overviewMessage(client, await client.feed());
  setRevisions([revision(101), revision(100)]); await client.feed(true);
  const detail = await browseMessage(client, control(overview, 'entity'), ['0']);
  assert.match(detail.embeds[0]!.description!, /Rev\. 100/);
  const newRevision = parseFeed(page({ revisions: [revision(100, 1, 'new')] }), 1).revisions[0]!;
  await client.entityDetails(newRevision.entities[0]!, newRevision);
  assert.equal(reads.at(-1)!.pathname, '/characters/0/mirror/beta/9.0.51/100/__data.json');
  setRevisions([revision(101)]); await client.feed(true);
  await assert.rejects(browseMessage(client, control(overview, 'entity'), ['0']), /no longer in the retrieved archive/);
  assert.throws(() => readView('beta:https://elsewhere.invalid:entity', ['0']));
});

test('source failures leave an explicit retry instead of turning links into the entire result', async () => {
  const { client, fail } = fixture();
  const overview = latestMessage(await client.feed()); fail();
  const message = await browseMessage(client, control(overview, 'entity'), ['0']);
  assert.match(message.embeds[0]!.description!, /could not be retrieved/);
  assert.ok(components(message).some(component => component.type === 2 && component.label === 'Retry'));
});

test('public copies preserve exactly the displayed information and omit private flags and share controls', () => {
  const feed = parseFeed(page({ revisions: [revision()] }), 1);
  const original = answerMessage('The exact answer @everyone', feed);
  const messageWithMetadata = { ...original, flags: 64, id: 'private-message', attachments: ['private'] };
  const shared = sharedMessage(messageWithMetadata);
  assert.deepEqual(shared.embeds, original.embeds);
  assert.ok(!('flags' in shared) && !('id' in shared) && !('attachments' in shared));
  assert.ok(!JSON.stringify(shared.components).includes(':share'));
  assert.ok(JSON.stringify(original.components).includes(':share'));
});

function nodeInteraction(message: BetaMessage, customId: string, privateView = true, values: string[] = []) {
  const calls: { kind: string; payload?: unknown }[] = [];
  const interaction = { id: '523456789012345678', customId, guildId: '323456789012345678', deferred: false, replied: false,
    memberPermissions: new PermissionsBitField(1024n | 2048n), appPermissions: new PermissionsBitField(1024n | 2048n | 16384n),
    message: { flags: new MessageFlagsBitField(privateView ? 64 : 0), embeds: message.embeds.map(embed => ({ ...embed, toJSON: () => embed })),
      components: message.components?.map(row => ({ toJSON: () => row })) ?? [] },
    channel: { isSendable: () => true, isThread: () => false, send: async (payload: unknown) => { calls.push({ kind: 'send', payload }); } },
    deferReply: async (payload: unknown) => { interaction.deferred = true; calls.push({ kind: 'deferReply', payload }); },
    deferUpdate: async () => { interaction.deferred = true; calls.push({ kind: 'deferUpdate' }); },
    editReply: async (payload: unknown) => { calls.push({ kind: 'edit', payload }); },
    reply: async (payload: unknown) => { calls.push({ kind: 'reply', payload }); },
    values, isStringSelectMenu: () => values.length > 0,
  };
  return { interaction, calls };
}
function context(client: BetaClient): BotContext {
  return { config: { token: 'unused', applicationId: '123456789012345678', ai: null, web: null },
    beta: { client } as BotContext['beta'], chat: null, commands: new Map(), logger: { info() {}, warn() {}, error() {} } } as BotContext;
}

test('Node shares the exact viewed page without retrieval, disables mentions, and enforces channel permissions', async () => {
  const { client, reads } = fixture();
  const message = answerMessage('My exact answer.', parseFeed(page({ revisions: [revision()] }), 1));
  const { interaction, calls } = nodeInteraction(message, control(message, 'share'));
  await handleBetaComponent(interaction as unknown as MessageComponentInteraction, context(client));
  assert.equal(reads.length, 0);
  assert.deepEqual(calls.map(call => call.kind), ['deferReply', 'send', 'edit']);
  const sent = calls[1]!.payload as BetaMessage & { allowedMentions: unknown; nonce: string };
  assert.deepEqual(sent.embeds, message.embeds);
  assert.deepEqual(sent.allowedMentions, { parse: [] });
  assert.equal(sent.nonce, interaction.id);
  assert.ok(!JSON.stringify(sent.components).includes(':share'));
  for (const target of ['memberPermissions', 'appPermissions'] as const) {
    const denied = nodeInteraction(message, control(message, 'share'));
    denied.interaction[target] = new PermissionsBitField(1024n);
    await handleBetaComponent(denied.interaction as unknown as MessageComponentInteraction, context(client));
    assert.ok(!denied.calls.some(call => call.kind === 'send'));
    assert.match(JSON.stringify(denied.calls.at(-1)), /permission|Embed Links/);
  }
});

test('Node opens shared controls privately and updates private pagination in place', async () => {
  const { client } = fixture();
  const message = latestMessage(await client.feed());
  for (const privateView of [false, true]) {
    const result = nodeInteraction(message, viewId({ revision: 'beta_9.0.51_100', entity: 0, section: 'changes', page: 0 }), privateView);
    await handleBetaComponent(result.interaction as unknown as MessageComponentInteraction, context(client));
    assert.equal(result.calls[0]!.kind, privateView ? 'deferUpdate' : 'deferReply');
    assert.ok(!result.calls.some(call => call.kind === 'send'));
    assert.match(JSON.stringify(result.calls.at(-1)), /Deals 50%.*↓.*Deals 75%/s);
  }
});

test('Node uploads rendered comparison pages and clears images when switching to selectable text', async () => {
  const { client } = fixture();
  const message = latestMessage(await client.feed());
  const result = nodeInteraction(message, viewId({ revision: 'beta_9.0.51_100', entity: 0, section: 'changes', page: 0 }));
  result.interaction.appPermissions = new PermissionsBitField(1024n | 2048n | 16384n | 32768n);
  await handleBetaComponent(result.interaction as unknown as MessageComponentInteraction, context(client));
  const payload = result.calls.at(-1)!.payload as BetaMessage & { files: { name: string; attachment: Buffer }[]; attachments: unknown[] };
  assert.equal(payload.embeds[0]!.image?.url, 'attachment://beta-diff.png');
  assert.equal(payload.files[0]!.name, 'beta-diff.png');
  assert.deepEqual([...payload.files[0]!.attachment.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const plain = nodeInteraction(message, viewId({ revision: 'beta_9.0.51_100', entity: 0, section: 'changes', page: 0 }, 'format'), true, ['text']);
  await handleBetaComponent(plain.interaction as unknown as MessageComponentInteraction, context(client));
  const text = plain.calls.at(-1)!.payload as { attachments: unknown[]; files: unknown[]; embeds: BetaMessage['embeds'] };
  assert.deepEqual(text.attachments, []); assert.deepEqual(text.files, []);
  assert.equal(text.embeds[0]!.image, undefined);
  assert.match(text.embeds[0]!.fields![0]!.value, /50%[\s\S]*↓[\s\S]*75%/);
});
