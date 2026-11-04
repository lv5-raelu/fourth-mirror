import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardReply, unsafeReply } from '../src/chat/safety.ts';

// Keep offensive fixtures local to safety tests; never print the transformed result in an assertion label.
const prohibited = String.fromCharCode(110, 105, 103, 103, 101, 114);

test('blocks known slurs across case, Markdown, separators, lookalikes, and data escapes', () => {
  const characters = [...prohibited];
  const variants = [
    prohibited, prohibited.toUpperCase(), `${prohibited}s`, `"${prohibited}"`,
    `||${prohibited}||`, `\`\`\`text\n${prohibited}\n\`\`\``, JSON.stringify({ answer: prohibited }),
    characters.join(' '), characters.join('-'), characters.join('**'), characters.join('\n'),
    characters.join('\u200b'), characters.join('\u0000'), characters.map(letter => letter + '\u0301').join(''),
    'n1gg3r', 'n!gg3r', 'nіggеr', 'ｎｉｇｇｅｒ',
    characters.map(letter => `\\u${letter.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
    characters.map(letter => `\\u{${letter.charCodeAt(0).toString(16)}}`).join(''),
    characters.map(letter => `\\x${letter.charCodeAt(0).toString(16)}`).join(''),
    characters.map(letter => `&#${letter.charCodeAt(0)};`).join(''),
    characters.map(letter => `&#x${letter.charCodeAt(0).toString(16)};`).join(''),
    characters.map(letter => `%${letter.charCodeAt(0).toString(16)}`).join(''),
    characters.map(letter => `%25${letter.charCodeAt(0).toString(16)}`).join(''),
    `Source: [${prohibited}](https://example.com/article)`,
    `[A source](https://example.com/${prohibited})`,
    String.fromCharCode(102, 97, 103, 103, 111, 116),
    String.fromCharCode(107, 105, 107, 101),
    String.fromCharCode(119, 101, 116, 98, 97, 99, 107),
  ];
  for (let index = 0; index < variants.length; index++) {
    assert.equal(guardReply(variants[index]!), unsafeReply, `unsafe fixture ${index}`);
  }
});

test('keeps harmless decoding, sensitive-topic discussion, exact formats, and incidental substrings intact', () => {
  const safe = [
    'HELLO', 'Decoded: hello world.', '01001000 01001001',
    'Racism and antisemitism harm people. Report harassment to the moderators.',
    'That encoded result is a [racial slur], which I will not reproduce.',
    'Nigeria and Niger are countries in West Africa.',
    'A niggardly allowance is an ungenerous one.',
    'There is a chink in the armor; the dyke holds back water.',
    'The word snigger means a quiet laugh.',
    '{"ok":true}', 'print("hello")', 'https://example.com/safe?q=1',
    '\\u{110000} \\uD800 &#9999999; &#xFFFFFF; %FF%ZZ',
    'a'.repeat(16_000), '🙂'.repeat(10_000),
  ];
  for (const answer of safe) assert.equal(guardReply(answer), answer);
  assert.equal(guardReply(unsafeReply), unsafeReply);
});
