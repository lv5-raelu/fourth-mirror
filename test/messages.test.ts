import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitDiscordMessage } from '../src/chat/messages.ts';

test('splits long Discord replies without losing text or breaking emoji', () => {
  for (const text of ['Short reply', 'x'.repeat(2_001), `${'x'.repeat(1_999)}🙂${'y'.repeat(4_500)}`, `${'a'.repeat(1_500)}\n${'b'.repeat(3_000)}`]) {
    const chunks = splitDiscordMessage(text);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 2_000 && !/[\uD800-\uDFFF]/u.test(chunk)));
  }
});
