import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultLoreLibrary, loreCatalogueInfo } from '../src/lore/index.ts';
import { requestsSpoilerFreeAnswer, LoreLibrary, MAX_LORE_CHARACTERS, MAX_LORE_ENTRIES } from '../src/lore/library.ts';
import { LoreTurn } from '../src/lore/turn.ts';
import type { LoreEntry } from '../src/lore/types.ts';
import { loreConnections } from '../src/lore/connections.ts';

const fixture: LoreEntry = { id: 'test-lore', title: 'Synthetic Test Lore', aliases: ['synthetic lore'], category: 'history', content: 'A synthetic fact.',
  related: [], sources: [{ title: 'Synthetic reference', url: 'https://example.com/lore', kind: 'game-text' }],
  release: '1.0', reviewedAt: '2026-11-04', spoiler: 'setting', status: 'released' };

test('catalogue loads with connected entries and source/release/spoiler metadata across its setting categories', () => {
  assert.ok(loreCatalogueInfo.entries >= 120);
  assert.equal(loreCatalogueInfo.connections, loreConnections.length);
  assert.equal(defaultLoreLibrary.entries.length, loreCatalogueInfo.entries);
  const categories = new Set(defaultLoreLibrary.entries.map(entry => entry.category));
  for (const category of ['cosmology', 'person', 'faction', 'location', 'lifeform', 'culture', 'technology', 'history'] as const) assert.ok(categories.has(category));
  for (const entry of defaultLoreLibrary.entries) {
    assert.ok(entry.sources.length);
    assert.ok(entry.release);
    assert.equal(entry.reviewedAt, loreCatalogueInfo.reviewedAt);
  }
});

test('expanded retrieval covers food, government, newer worlds, lifeforms, characters, and historical events', () => {
  for (const [question, expected] of [
    ['What food is popular on the Luofu?', 'xianzhou-drinks'],
    ['What do people eat in Belobog?', 'belobog-food'],
    ['Explain Amphoreus cuisine.', 'golden-honeycake'],
    ['How is the Luofu governed?', 'xianzhou-government'],
    ['Explain the Bloodhound Family.', 'penacony-lineages'],
    ['What is Astropolis?', 'astropolis'],
    ['What are imagenae?', 'imagenae'],
    ['Tell me about Phainon.', 'phainon'],
    ['Explain the Mechanical Emperor\'s Wars.', 'mechanical-wars'],
    ['Explain Amphoreus ending.', 'amphoreus-nature'],
  ]) assert.ok(defaultLoreLibrary.search(question!).some(entry => entry.id === expected), question);
  assert.ok(defaultLoreLibrary.search('HSR politics').some(entry => entry.id === 'political-systems'));
  assert.ok(defaultLoreLibrary.search('Important characters in HSR').some(entry => entry.category === 'person'));
  for (const question of ['Tell me about Asterwisp species in HSR.', 'My family visits on Sunday.', 'How do I sharpen a blade?',
    'Why is jade green?', 'What is a substitution cipher?', 'How do I photograph the golden hour?', 'My appointment is March 7th.']) {
    assert.deepEqual(defaultLoreLibrary.search(question), [], question);
  }
});

test('ordinary concepts retrieve one small sourced comparison without pretending they are literal lore aliases', () => {
  for (const [question, expected] of [
    ['I bought bubble tea after work.', 'immortals-delight'],
    ['Why do old food trends return?', 'golden-honeycake'],
    ['I love public baths as a social space.', 'okhema'],
    ['How do I plan delivery routes?', 'aurum-alley'],
    ['Why do optical illusions change with viewpoint?', 'penacony-dreamers'],
    ['Explain machine translation.', 'synesthesia-beacons'],
    ['What does preventive maintenance achieve?', 'jing-yuan-yanqing'],
  ]) {
    assert.deepEqual(defaultLoreLibrary.search(question!), [], question);
    const match = defaultLoreLibrary.connection(question!)!;
    assert.ok(match.entries.some(entry => entry.id === expected), question);
    assert.ok(match.entries.length <= 2);
    assert.ok(match.entries.every(entry => entry.spoiler === 'setting' && entry.status === 'released' && entry.sources.length));
    assert.ok(match.entries.reduce((size, entry) => size + JSON.stringify(entry).length + 60, 0) <= 3_000);
    const turn = new LoreTurn(defaultLoreLibrary, question!);
    const context = JSON.parse(turn.initial(question!)!);
    assert.equal(context.connection.comparison, match.comparison);
    assert.equal(context.entries[0].source_id, 'L1');
    assert.ok(!turn.renderCitations('A short connection. [L1]').includes('[L1]'));
  }
  assert.equal(defaultLoreLibrary.connection('What is the time?'), undefined);
  assert.equal(new LoreTurn(defaultLoreLibrary, 'Asterwisp species in HSR.').initial('Asterwisp species in HSR.')!.includes('connection'), false);
});

test('optional connections stay out of exact output, opt-outs, distress, quotations, and code', () => {
  for (const question of [
    'No game references: why do I like milk tea?',
    'Explain milk tea without Star Rail analogies.',
    'Do not mention HSR. Explain public baths.',
    'Only JSON: a bubble tea menu.',
    'Give me code only for delivery routes.',
    'I am grieving and miss buying milk tea with my friend.',
    'My friend died. We used to love public baths.',
    'I experience discrimination at work while making bubble tea.',
    'Someone said "milk tea". What is two plus two?',
    '> public baths\nWhat is two plus two?',
    'Explain `machine translation` as literal code, not its meaning.',
    '```text\nmilk tea and public baths\n```\nWhat is two plus two?',
  ]) assert.equal(defaultLoreLibrary.connection(question), undefined, question);
  const context = JSON.parse(new LoreTurn(defaultLoreLibrary, 'Explain HSR Amphoreus ending without spoilers.').initial('Explain HSR Amphoreus ending without spoilers.')!);
  assert.ok(context.entries.every((item: { entry: LoreEntry }) => item.entry.spoiler === 'setting'));
  const simulated = defaultLoreLibrary.connection('How should I design a research simulation?')!;
  assert.ok(!simulated.entries.some(entry => entry.id === 'amphoreus-nature'));
});

test('connection definitions cannot refer to absent, beta, or story entries', () => {
  const bridge = { id: 'test', phrases: ['test concept'], entryIds: [fixture.id], comparison: 'A limited shared feature.' };
  assert.doesNotThrow(() => new LoreLibrary([fixture], [bridge]));
  for (const connections of [
    [{ ...bridge, entryIds: ['missing'] }], [{ ...bridge, phrases: [] }], [bridge, bridge],
    [{ ...bridge, comparison: '' }],
  ]) assert.throws(() => new LoreLibrary([fixture], connections), /Invalid lore connection/);
  for (const entry of [{ ...fixture, spoiler: 'story' as const }, { ...fixture, status: 'beta' as const }, { ...fixture, status: 'in-universe-account' as const }]) {
    assert.throws(() => new LoreLibrary([entry], [bridge]), /Invalid lore connection/);
  }
});

test('retrieval recognizes whole aliases, Unicode numerals, comparisons, and short faction names without hijacking everyday words', () => {
  assert.equal(defaultLoreLibrary.search('What is Jarilo-Ⅵ?')[0]?.id, 'jarilo-vi');
  assert.equal(defaultLoreLibrary.search('Explain the IPC.')[0]?.id, 'ipc');
  assert.ok(defaultLoreLibrary.search('What species live in HSR?').every(entry => entry.category === 'lifeform'));
  assert.ok(defaultLoreLibrary.search('What species live in HSR?').length > 0);
  assert.deepEqual(defaultLoreLibrary.search('Tell me about the Asterwisp species in Honkai Star Rail.'), []);
  const comparison = defaultLoreLibrary.search('How do Foxians and Vidyadhara differ?').map(entry => entry.id);
  assert.ok(comparison.includes('foxians'));
  assert.ok(comparison.includes('vidyadhara'));
  for (const query of ['What is this topic about?', 'How do I change a file path in Python?', 'Who gets credits in this film?', 'My family is visiting.', 'Write only JSON.']) {
    assert.deepEqual(defaultLoreLibrary.search(query), [], query);
  }
  const broad = defaultLoreLibrary.search('Honkai Star Rail cosmology, Aeons, Nous, IPC, Herta, Foxians, Vidyadhara, Penacony');
  assert.ok(broad.length <= MAX_LORE_ENTRIES);
  assert.ok(broad.reduce((size, entry) => size + JSON.stringify(entry).length + 60, 0) <= MAX_LORE_CHARACTERS);
});

test('story entries are available by default while explicit spoiler-free requests and released-canon filters remain enforced', () => {
  const library = new LoreLibrary([fixture, { ...fixture, id: 'test-story', title: 'Synthetic Story', aliases: ['synthetic story'], spoiler: 'story', content: 'A synthetic plot twist.' },
    { ...fixture, id: 'test-beta', status: 'beta' }, { ...fixture, id: 'test-theory', status: 'interpretation' }]);
  assert.ok(library.search('synthetic story').some(entry => entry.id === 'test-story'));
  assert.deepEqual(library.search('synthetic story', 'setting'), []);
  assert.ok(library.search('synthetic lore', 'story').every(entry => ['released', 'in-universe-account'].includes(entry.status)));
  for (const text of ['spoilers allowed', 'Include plot spoilers', 'Spoil the ending', 'Spoilers are okay', 'Explain synthetic story.',
    'Someone said "no spoilers".', "Someone said 'no spoilers'.", '> no spoilers\nExplain the ending.']) assert.equal(requestsSpoilerFreeAnswer(text), false, text);
  for (const text of ['no spoilers', 'spoiler-free explanation', 'do not spoil the story', 'do not allow spoilers', 'no major spoilers', 'spoilers allowed, but no spoilers for the ending',
    ]) assert.equal(requestsSpoilerFreeAnswer(text), true, text);
  const tagged = new LoreTurn(library, 'Explain synthetic story.');
  assert.ok(JSON.parse(tagged.initial('Explain synthetic story.')!).entries.some((item: { entry: LoreEntry }) => item.entry.id === 'test-story'));
  const turn = new LoreTurn(library, 'Tell me about synthetic lore without spoilers.');
  const response = turn.run(JSON.stringify({ query: 'synthetic story spoilers allowed' }));
  assert.ok(!response.includes('synthetic plot twist'));
  assert.ok(!turn.run(JSON.stringify({ query: 'synthetic story', include_spoilers: true })).includes('synthetic plot twist'));
});

test('story citations conceal untagged paragraphs and revealing source titles without hiding setting paragraphs or rewriting code/data', () => {
  const story = { ...fixture, id: 'test-story', title: 'Synthetic Story', aliases: ['synthetic story'], spoiler: 'story' as const,
    sources: [{ ...fixture.sources[0]!, title: 'The archivist || is the saboteur', url: 'https://example.com/story_(ending)||' }] };
  const turn = new LoreTurn(new LoreLibrary([fixture, story]), 'Explain synthetic story. Cite sources.');
  const initial = JSON.parse(turn.initial('Explain synthetic story.')!);
  const marker = initial.entries.find((item: { entry: LoreEntry }) => item.entry.id === story.id).source_id;
  const link = '(Source: [The archivist \\|\\| is the saboteur](<https://example.com/story_%28ending%29%7C%7C>))';
  assert.equal(turn.renderCitations(`A public setting fact.\n\nThe archivist is the saboteur. [${marker}]`), `A public setting fact.\n\n||The archivist is the saboteur. ${link}||`);
  assert.equal(turn.renderCitations(`The outcome: ||the expedition ends.|| [${marker}]`), `||The outcome: the expedition ends. ${link}||`);
  assert.equal(turn.renderCitations(`||The expedition ends. [${marker}]||`), `||The expedition ends. ${link}||`);
  assert.equal(turn.renderCitations(`A comparison that also gives away the twist. ||The ending. [${marker}]||`),
    `||A comparison that also gives away the twist. The ending. ${link}||`);
  assert.equal(turn.renderCitations('An uncited plot revelation.'), '||An uncited plot revelation.||');
  const data = JSON.stringify({ literal: `[${marker}]` });
  assert.equal(turn.renderCitations(data), data);
  const code = '```text\n[' + marker + ']\n```';
  assert.equal(turn.renderCitations(code), code);
});

test('lore turn bounds lookups, caches identical queries, preserves source attribution, and renders only supplied citations', () => {
  const library = new LoreLibrary([fixture, { ...fixture, id: 'test-account', title: 'Synthetic account', aliases: ['synthetic account'], status: 'in-universe-account' }]);
  const turn = new LoreTurn(library, 'Explain synthetic lore. Cite sources.');
  const initial = JSON.parse(turn.initial('Explain synthetic lore.')!);
  assert.equal(initial.entries[0].source_id, 'L1');
  assert.equal(initial.entries[0].entry.release, '1.0');
  assert.equal(initial.entries[0].entry.sources[0].kind, 'game-text');
  const account = turn.run('{"query":"synthetic account"}');
  assert.equal(turn.run('{"query":"synthetic account"}'), account);
  assert.match(account, /in-universe-account/);
  assert.equal(turn.renderCitations('Fact [L1](https://invented.example/). Unknown [L99].'), 'Fact (Source: [Synthetic reference](<https://example.com/lore>)). Unknown.');
  assert.equal(turn.renderCitations('{"literal":"[L1]"}'), '{"literal":"[L1]"}');
  assert.equal(turn.renderCitations('```python\nvalue = "[L1]"\n```'), '```python\nvalue = "[L1]"\n```');
  assert.equal(turn.renderCitations('Keep `[L1]` literal. Fact [L1].'), 'Keep `[L1]` literal. Fact (Source: [Synthetic reference](<https://example.com/lore>)).');
  assert.match(turn.run('not JSON'), /error/);
  assert.match(turn.run(JSON.stringify({ query: 'x'.repeat(241) })), /error/);
  for (let index = 0; index < 5; index++) turn.run(JSON.stringify({ query: 'synthetic lore ' + index }));
  assert.match(turn.run('{"query":"synthetic lore new"}'), /budget reached/);
  assert.equal(new LoreTurn(library, 'Write JSON.').renderCitations('{"literal":"[L1]"}'), '{"literal":"[L1]"}');
  const species = JSON.parse(new LoreTurn(defaultLoreLibrary, 'Tell me about its inhabitants.').run('{"query":"species"}'));
  assert.ok(species.entries.length > 0);
});

test('invalid, duplicate, unsourced, or disconnected entries fail before they can be used', () => {
  for (const entries of [[fixture, fixture], [{ ...fixture, sources: [] }], [{ ...fixture, related: ['missing'] }],
    [{ ...fixture, sources: [{ ...fixture.sources[0]!, url: 'https://user:password@example.com/' }] }],
    [{ ...fixture, content: 'x'.repeat(1_801) }]]) assert.throws(() => new LoreLibrary(entries));
});
