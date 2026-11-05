import assert from 'node:assert/strict';
import { test } from 'node:test';
import UPNG from 'upng-js';
import { wordDiff } from '../src/beta/diff.ts';
import { diffImagePages } from '../src/beta/diff-image.ts';
import { renderDiffImage } from '../src/beta/render.ts';
import { prepareSharedMessage } from '../src/beta/share-image.ts';
import type { BetaMessage } from '../src/beta/types.ts';

const changed = (runs: ReturnType<typeof wordDiff>['before']) => runs.filter(run => run.changed).map(run => run.text);
const entry = (before: string | null, after: string | null, name = 'Skill · Frostbeam') => ({ name, value: '', comparison: { before, after } });

test('highlights complete percentage values and words, leaving common text neutral', () => {
  const before = 'Deals 100% DMG to one enemy for 2 turns.';
  const after = 'Deals 120% DMG to all enemies for 3 turns.';
  const diff = wordDiff(before, after);
  assert.deepEqual(changed(diff.before), ['100%', 'one', 'enemy', '2']);
  assert.deepEqual(changed(diff.after), ['120%', 'all', 'enemies', '3']);
  assert.equal(diff.before.map(run => run.text).join(''), before);
  assert.equal(diff.after.map(run => run.text).join(''), after);
});

test('keeps decimals, grouped and signed numbers, contractions, Unicode, and hyphenated words whole', () => {
  const diff = wordDiff("Gain -1,000.25% follow-up hits; café's bonus is +2.5.", "Gain -1,200.75% follow-ups hits; cafés bonus is +3.5.");
  assert.deepEqual(changed(diff.before), ['-1,000.25%', 'follow-up', "café's", '+2.5']);
  assert.deepEqual(changed(diff.after), ['-1,200.75%', 'follow-ups', 'cafés', '+3.5']);
  assert.deepEqual(changed(wordDiff('Gain 100', 'Gain 100%').before), ['100']);
  assert.deepEqual(changed(wordDiff('unchanged!', 'unchanged!').after), []);
});

test('handles additions, removals, and rewritten paragraphs without losing original text', () => {
  assert.deepEqual(changed(wordDiff('', 'New effect').after), ['New', 'effect']);
  assert.deepEqual(changed(wordDiff('Old effect', '').before), ['Old', 'effect']);
  const before = 'Old '.repeat(100), after = 'New '.repeat(100);
  const diff = wordDiff(before, after);
  assert.equal(diff.before.map(run => run.text).join(''), before);
  assert.equal(diff.after.map(run => run.text).join(''), after);
  assert.throws(() => wordDiff('Old '.repeat(1_000), 'New '.repeat(1_000)), /highlighting work limit/);
  const long = 'Common context '.repeat(1_000);
  const precise = wordDiff(`100% ${long} 2 turns`, `120% ${long} 3 turns`);
  assert.deepEqual(changed(precise.before), ['100%', '2']);
  assert.deepEqual(changed(precise.after), ['120%', '3']);
});

test('paginates both sides of long comparisons without exceeding the image bounds or dropping the ending', () => {
  const before = 'A long unchanged paragraph. '.repeat(300) + '100% END';
  const after = 'A long unchanged paragraph. '.repeat(300) + '120% END';
  const pages = diffImagePages([entry(before, after)]);
  assert.ok(pages.length > 5);
  assert.ok(pages.every(page => page.width === 1_000 && page.height <= 1_600));
  const text = pages.map(page => page.text).join('\n');
  assert.match(text, /100%\s+END/); assert.match(text, /120%\s+END/);
  assert.ok(pages.every(page => !page.svg.includes('Before:') && !page.svg.includes('After:')));
  assert.match(pages.at(-1)!.svg, />100%<\/tspan>/);
  assert.match(pages.at(-1)!.svg, />120%<\/tspan>/);
});

test('escapes source text rather than letting it introduce SVG markup or external image loads', async () => {
  const page = diffImagePages([entry('<image href="https://private.invalid/"/> 100%', '<script>bad</script> 120%', '<script>Title</script>')])[0]!;
  assert.ok(!page.svg.includes('<image ') && !page.svg.includes('<script>'));
  assert.ok(page.svg.includes('&lt;'));
  const bytes = await renderDiffImage(page);
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('renders a real PNG containing neutral text, red removals, and green additions, and reuses identical images', async () => {
  const page = diffImagePages([entry('Deals 100% DMG to one enemy.', 'Deals 120% DMG to all enemies.')])[0]!;
  const [first, second] = await Promise.all([renderDiffImage(page), renderDiffImage(page)]);
  assert.deepEqual(first, second);
  const decoded = UPNG.decode(new Uint8Array(first).buffer);
  assert.equal(decoded.width, page.width); assert.equal(decoded.height, page.height);
  const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0]!);
  const colors = new Set<string>();
  for (let index = 0; index < pixels.length; index += 4) colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`);
  assert.ok(colors.has('255,139,148')); assert.ok(colors.has('131,227,164')); assert.ok(colors.has('227,229,232'));
});

test('sharing downloads and reuploads the exact private PNG without source retrieval or forwarding credentials', async () => {
  const png = await renderDiffImage(diffImagePages([entry('100%', '120%')])[0]!);
  const original: BetaMessage = { embeds: [{ title: 'Character', color: 1, footer: { text: 'Gachabase' },
    image: { url: 'https://cdn.discordapp.com/ephemeral-attachments/333456789012345678/999456789012345678/beta-diff.png?hm=synthetic' } }] };
  let reads = 0;
  const shared = await prepareSharedMessage(original, async (input, init) => {
    reads++; assert.equal(new URL(String(input)).hostname, 'cdn.discordapp.com');
    assert.equal(init?.redirect, 'manual'); assert.equal(init?.headers, undefined);
    return new Response(new Uint8Array(png).buffer);
  });
  assert.equal(reads, 1); assert.deepEqual(shared.files![0]!.data, png);
  assert.equal(shared.embeds[0]!.image!.url, 'attachment://beta-diff.png');
  assert.ok(original.embeds[0]!.image!.url.startsWith('https:'));
});

test('sharing rejects non-CDN images, redirects, excessive downloads, and invalid image bytes', async () => {
  const original = (url: string): BetaMessage => ({ embeds: [{ title: 'Character', color: 1, footer: { text: 'Gachabase' }, image: { url } }] });
  let requests = 0;
  await assert.rejects(prepareSharedMessage(original('https://private.invalid/beta-diff.png'), async () => { requests++; return new Response(); }), /couldn’t copy/);
  assert.equal(requests, 0);
  const valid = original('https://cdn.discordapp.com/attachments/333456789012345678/999456789012345678/beta-diff.png');
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid' } }), new Response(new Uint8Array(2 * 1024 * 1024 + 1)), new Response('not a PNG')]) {
    await assert.rejects(prepareSharedMessage(valid, async () => response), /couldn’t copy/);
  }
});
