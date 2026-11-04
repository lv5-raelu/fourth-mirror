import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitDiscordMessage, truncateDiscordText } from '../src/chat/messages.ts';
import { closeSpoilers, hideSpoilerText, spoilerDelimiters, spoilerSpans } from '../src/chat/spoilers.ts';

test('splits long Discord replies without losing text or breaking emoji', () => {
  for (const text of ['Short reply', 'x'.repeat(2_001), `${'x'.repeat(1_999)}🙂${'y'.repeat(4_500)}`, `${'a'.repeat(1_500)}\n${'b'.repeat(3_000)}`]) {
    const chunks = splitDiscordMessage(text);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 2_000 && !/[\uD800-\uDFFF]/u.test(chunk)));
  }
});

test('long spoiler spans stay hidden in every Discord chunk, including delimiters and emoji at split boundaries', () => {
  for (const text of ['||' + 'secret '.repeat(1_000) + '||', 'Visible.\n||' + ('secret🙂\n'.repeat(700)) + '||\nVisible again.',
    'v'.repeat(1_997) + '||' + 's'.repeat(4_200) + '|| visible', 'v'.repeat(1_996) + '||' + 'secret '.repeat(500) + '||',
    '||' + 's'.repeat(1_995) + '||' + 'v'.repeat(2_500),
    'Visible. ||' + 'secret '.repeat(1_000)]) {
    const chunks = splitDiscordMessage(text);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.length <= 2_000 && spoilerDelimiters(chunk).length % 2 === 0 && !/[\uD800-\uDFFF]/u.test(chunk)));
    // Only extra spoiler delimiters are inserted; no answer text is lost.
    assert.equal(chunks.join('').replaceAll('||', ''), text.replaceAll('||', ''));
    assert.ok(chunks.every(chunk => !chunk.replace(/\|\|[\s\S]*?\|\|/g, '').includes('secret')));
    assert.ok(chunks.every(chunk => !chunk.includes('||||')));
  }
});

test('literal pipes in code, escapes, and exact JSON are preserved while output truncation closes real spoilers', () => {
  for (const text of ['Use `a || b`.', '```js\na || b\n```', '\\|\\|literal pipes', '{"literal":"||"}']) {
    assert.deepEqual(splitDiscordMessage(text), [text]);
    assert.equal(closeSpoilers(text), text);
  }
  assert.equal(hideSpoilerText('A ||hidden|| and visible sentence.'), '||A hidden and visible sentence.||');
  assert.deepEqual(spoilerSpans('visible ||hidden||'), [{ start: 8, end: 18 }]);
  const text = 'A setting fact. ||' + 'secret🙂'.repeat(3_000) + '|| visible end';
  const shortened = truncateDiscordText(text, 3_800, '\n\n*Shortened.*');
  assert.ok(shortened.length <= 3_800);
  assert.equal(spoilerDelimiters(shortened).length, 2);
  assert.ok(shortened.endsWith('||\n\n*Shortened.*'));
  assert.ok(!/[\uD800-\uDFFF]/u.test(shortened));
});
