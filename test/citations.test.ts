import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSourceMarkers, requestsLoreSources, requestsNoLinks, sourceLinksToMarkers, sourceNote } from '../src/chat/citations.ts';

const first = { title: 'Official profile', url: 'https://example.com/profile?a=1&b=2' };
const second = { title: 'World guide', url: 'https://example.com/world' };
const sources = new Map([['L1', [first]], ['L2', [second]], ['L3', [first]]]);

test('casual lore needs no visible sources; explicit resource requests and no-link preferences are recognized', () => {
  for (const question of ['Who is Himeko?', 'LeBron replaces Himeko in Star Rail, how would the story go?',
    'I bought milk tea.', 'Explain this code: `sources = []`', 'They said "give me sources". Who is Himeko?',
    'How does the IPC manage economic resources?', 'What energy sources does Belobog use?', 'Explain the cultural links between these worlds.']) {
    assert.equal(requestsLoreSources(question), false, question);
  }
  for (const question of ['Who is Himeko? Cite sources.', 'Where can I read more about the Astral Express?',
    'Give me a link to her profile.', 'What is your evidence?', 'What evidence supports that?', 'What are your sources?', 'Sources please.',
    'Explain it with references.']) assert.equal(requestsLoreSources(question), true, question);
  for (const question of ['Explain Himeko without links.', 'Sources are fine, but do not include URLs.',
    "Don't add sources.", 'Skip citations please.']) {
    assert.equal(requestsNoLinks(question), true, question);
    assert.equal(requestsLoreSources(question), false, question);
  }
  assert.equal(requestsNoLinks('Explain `no links` as text.'), false);
});

test('source markers become separate parenthetical notes with grouped, deduplicated sources', () => {
  const note = sourceNote([first, second]);
  assert.equal(renderSourceMarkers('Fact. [L1] [L2] [L3]', 'L', sources), 'Fact. ' + note);
  assert.equal(renderSourceMarkers('Fact ([L1]).', 'L', sources), 'Fact ' + sourceNote([first]) + '.');
  assert.equal(renderSourceMarkers('Fact. (Source: [L1])', 'L', sources), 'Fact. ' + sourceNote([first]));
  assert.equal(renderSourceMarkers('Fact.[L1]Next.', 'L', sources), 'Fact. ' + sourceNote([first]) + ' Next.');
  assert.match(sourceNote([{ title: 'A [title] || ending', url: 'https://example.com/story_(end)||' }]),
    /\(Source: \[A \\\[title\\\] \\\|\\\| ending\]\(<https:\/\/example.com\/story_%28end%29%7C%7C>\)\)/);
});

test('copied Markdown and bare registered URLs follow the same policy as markers', () => {
  const input = 'She repaired the Express. [Official profile](<' + first.url + '>)';
  assert.equal(sourceLinksToMarkers(input, sources), 'She repaired the Express. [L1]');
  assert.equal(renderSourceMarkers(sourceLinksToMarkers(input, sources), 'L', sources, false), 'She repaired the Express.');
  assert.equal(sourceLinksToMarkers('Fact. ' + second.url + '.', sources), 'Fact. [L2].');
  assert.equal(sourceLinksToMarkers('||Fact. ' + second.url + '||', sources), '||Fact. [L2]||');
  const parenthesized = new Map([['L1', [{ title: 'Guide', url: 'https://example.com/story_(ending)' }]]]);
  assert.equal(sourceLinksToMarkers('[Guide](https://example.com/story_(ending))', parenthesized), '[L1]');
  assert.equal(renderSourceMarkers('Fact (Sources: [L1], [L2]). Unknown [L99].', 'L', sources, false), 'Fact. Unknown.');
});

test('formatting preserves exact JSON, code, literal URLs, and existing spoiler boundaries', () => {
  for (const input of ['{"source":"[L1]","url":"' + first.url + '"}',
    '```js\nconst source = "[L1]";\nconst url = "' + first.url + '";\n```', '`[L1] ' + first.url + '`']) {
    assert.equal(renderSourceMarkers(sourceLinksToMarkers(input, sources), 'L', sources, false), input);
  }
  assert.equal(sourceLinksToMarkers('https://unrelated.example/data', sources), 'https://unrelated.example/data');
  const webSources = new Map([['S1', [first]]]);
  assert.equal(renderSourceMarkers('||The ending. [S1]||', 'S', webSources, true, true), '||The ending. ' + sourceNote([first]) + '||');
  assert.equal(renderSourceMarkers('||The ending.|| [S1]', 'S', webSources, true, true), '||The ending.|| ||' + sourceNote([first]) + '||');
});
