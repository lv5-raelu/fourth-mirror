import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultLoreLibrary, loreCatalogueInfo } from '../src/lore/index.ts';
import { requestsSpoilerFreeAnswer, LoreLibrary, MAX_LORE_CHARACTERS, MAX_LORE_ENTRIES } from '../src/lore/library.ts';
import { LoreTurn } from '../src/lore/turn.ts';
import type { LoreEntry } from '../src/lore/types.ts';

const fixture: LoreEntry = { id: 'test-lore', title: 'Synthetic Test Lore', aliases: ['synthetic lore'], category: 'history', content: 'A synthetic fact.',
  related: [], sources: [{ title: 'Synthetic reference', url: 'https://example.com/lore', kind: 'game-text' }],
  release: '1.0', reviewedAt: '2026-11-04', spoiler: 'setting', status: 'released' };

test('catalogue loads with connected entries and source/release/spoiler metadata across its setting categories', () => {
  assert.ok(loreCatalogueInfo.entries >= 30);
  assert.equal(defaultLoreLibrary.entries.length, loreCatalogueInfo.entries);
  const categories = new Set(defaultLoreLibrary.entries.map(entry => entry.category));
  for (const category of ['cosmology', 'person', 'faction', 'location', 'lifeform', 'culture', 'technology', 'history'] as const) assert.ok(categories.has(category));
  for (const entry of defaultLoreLibrary.entries) {
    assert.ok(entry.sources.length);
    assert.ok(entry.release);
    assert.equal(entry.reviewedAt, loreCatalogueInfo.reviewedAt);
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
  const turn = new LoreTurn(new LoreLibrary([fixture, story]), 'Explain synthetic story.');
  const initial = JSON.parse(turn.initial('Explain synthetic story.')!);
  const marker = initial.entries.find((item: { entry: LoreEntry }) => item.entry.id === story.id).source_id;
  const link = '[The archivist \\|\\| is the saboteur](https://example.com/story_%28ending%29%7C%7C)';
  assert.equal(turn.renderCitations(`A public setting fact.\n\nThe archivist is the saboteur. [${marker}]`), `A public setting fact.\n\n||The archivist is the saboteur. ${link}||`);
  assert.equal(turn.renderCitations(`The outcome: ||the expedition ends.|| [${marker}]`), `||The outcome: the expedition ends. ${link}||`);
  assert.equal(turn.renderCitations(`||The expedition ends. [${marker}]||`), `||The expedition ends. ${link}||`);
  assert.equal(turn.renderCitations('An uncited plot revelation.'), '||An uncited plot revelation.||');
  const data = JSON.stringify({ literal: `[${marker}]` });
  assert.equal(turn.renderCitations(data), data);
  const code = '```text\n[' + marker + ']\n```';
  assert.equal(turn.renderCitations(code), code);
});

test('lore turn bounds lookups, caches identical queries, preserves source attribution, and renders only supplied citations', () => {
  const library = new LoreLibrary([fixture, { ...fixture, id: 'test-account', title: 'Synthetic account', aliases: ['synthetic account'], status: 'in-universe-account' }]);
  const turn = new LoreTurn(library, 'Explain synthetic lore.');
  const initial = JSON.parse(turn.initial('Explain synthetic lore.')!);
  assert.equal(initial.entries[0].source_id, 'L1');
  assert.equal(initial.entries[0].entry.release, '1.0');
  assert.equal(initial.entries[0].entry.sources[0].kind, 'game-text');
  const account = turn.run('{"query":"synthetic account"}');
  assert.equal(turn.run('{"query":"synthetic account"}'), account);
  assert.match(account, /in-universe-account/);
  assert.equal(turn.renderCitations('Fact [L1](https://invented.example/). Unknown [L99].'), 'Fact [Synthetic reference](https://example.com/lore). Unknown .');
  assert.equal(turn.renderCitations('{"literal":"[L1]"}'), '{"literal":"[L1]"}');
  assert.equal(turn.renderCitations('```python\nvalue = "[L1]"\n```'), '```python\nvalue = "[L1]"\n```');
  assert.equal(turn.renderCitations('Keep `[L1]` literal. Fact [L1].'), 'Keep `[L1]` literal. Fact [Synthetic reference](https://example.com/lore).');
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
