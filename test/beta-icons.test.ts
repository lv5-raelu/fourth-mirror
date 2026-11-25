import assert from 'node:assert/strict';
import { test } from 'node:test';
import UPNG from 'upng-js';
import { stringify } from 'devalue';
import { BetaIconClient } from '../src/beta/icons.ts';
import { parseDetails } from '../src/beta/source.ts';
import { currentImagePages, diffImagePages } from '../src/beta/diff-image.ts';
import { renderDiffImage } from '../src/beta/render.ts';

const iconUrl = 'https://cdn.gachabase.net/hsr/assets/' + 'a'.repeat(32) + '.png';
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGMUrHz+nwEPGCEKABhxE4k0XHgqAAAAAElFTkSuQmCC', 'base64'));
const page = (data: unknown) => JSON.stringify({ type: 'data', nodes: [{ type: 'data', data: JSON.parse(stringify({ data })) }] });
const ability = (description = 'Deals 100% DMG.') => ({ id: 42, name: { text: 'Beam' }, type: { text: 'Skill' }, icon_path_hash: '123', description: { text: description } });
const asset = { url: iconUrl, width: 128, height: 128, file_size: 10_000 };

test('resolves namespaced comparison icons and normal current-page icons without making artwork a balance change', () => {
  const details = parseDetails(page({ source: { dto: { skills: [ability()] }, refs: { assets: { '123-source': asset } } },
    target: { dto: { skills: [ability('Deals 120% DMG.')] }, refs: { assets: { '123-target': asset } } } }));
  assert.deepEqual(details.sections[0]!.entries[0]!.heading, { type: 'Skill', name: 'Beam', iconUrl });
  assert.equal(details.sections.find(section => section.id === 'kit')!.entries[0]!.heading!.iconUrl, iconUrl);
  const current = parseDetails(page({ dto: { skills: [ability()] }, refs: { assets: { '123': asset } } }));
  assert.equal(current.sections.find(section => section.id === 'kit')!.entries[0]!.heading!.iconUrl, iconUrl);
  const unchanged = parseDetails(page({ source: { dto: { skills: [ability()] }, refs: { assets: { '123-source': asset } } },
    target: { dto: { skills: [{ ...ability(), icon_path_hash: '456' }] }, refs: { assets: { '456-target': { ...asset, url: iconUrl.replace('/aaaa', '/bbbb') } } } } }));
  assert.equal(unchanged.changes.length, 0);
  assert.equal(unchanged.sections[0]!.entries[0]!.comparison, undefined);
});

test('keeps the previous icon for removed abilities and rejects off-source or oversized asset metadata', () => {
  const removed = parseDetails(page({ source: { dto: { skills: [ability()] }, refs: { assets: { '123-source': asset } } }, target: { dto: { id: 1 } } }));
  assert.equal(removed.sections[0]!.entries[0]!.heading!.iconUrl, iconUrl);
  for (const unsafe of [{ ...asset, url: 'https://elsewhere.invalid/asset.png' }, { ...asset, width: 4_096 }, { ...asset, file_size: 1_000_000 }]) {
    const data = parseDetails(page({ dto: { skills: [ability()] }, refs: { assets: { '123': unsafe } } }));
    assert.equal(data.sections.find(section => section.id === 'kit')!.entries[0]!.heading!.iconUrl, undefined);
  }
});

test('caches and coalesces icon reads, sends no credentials, and retries temporary failures after a short delay', async () => {
  let calls = 0, now = 10_000, failure = false;
  const client = new BetaIconClient(async (input, options) => {
    calls++; assert.equal(input, iconUrl); assert.equal(options?.headers, undefined); assert.equal(options?.redirect, 'manual');
    return failure ? new Response('Unavailable', { status: 503 }) : new Response(new Uint8Array(png).buffer);
  }, () => now);
  const results = await Promise.all([client.load(iconUrl), client.load(iconUrl)]);
  assert.equal(calls, 1); assert.deepEqual(results[0], png);
  now += 5 * 60_000 + 1; failure = true;
  assert.equal(await client.load(iconUrl), undefined);
  assert.equal(await client.load(iconUrl), undefined); assert.equal(calls, 2);
  now += 30_001; failure = false;
  assert.deepEqual(await client.load(iconUrl), png); assert.equal(calls, 3);
});

test('rejects arbitrary icon hosts, redirects, invalid PNGs, excessive bytes, and unsafe dimensions', async () => {
  let calls = 0;
  const client = new BetaIconClient(async () => { calls++; return new Response(); });
  assert.equal(await client.load('https://private.invalid/icon.png'), undefined); assert.equal(calls, 0);
  const huge = new Uint8Array(png); new DataView(huge.buffer).setUint32(16, 4_096);
  for (const response of [new Response(null, { status: 302 }), new Response('not a PNG'), new Response(new Uint8Array(256 * 1024 + 1)), new Response(huge.buffer)]) {
    const download = new BetaIconClient(async () => response);
    assert.equal(await download.load(iconUrl), undefined);
  }
});

test('renders the actual PNG to the left of a two-line type/name heading in comparison and current pages', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async input => { calls++; assert.equal(input, iconUrl); return new Response(new Uint8Array(png).buffer); };
  const entry = { name: 'Skill · Beam', value: 'Deals 120% DMG.', heading: { type: 'Skill', name: 'Beam', iconUrl }, comparison: { before: 'Deals 100% DMG.', after: 'Deals 120% DMG.' } };
  for (const page of [diffImagePages([entry])[0]!, currentImagePages([entry])[0]!]) {
    assert.equal(page.iconUrl, iconUrl);
    assert.match(page.svg, /<image[^>]+x="44"/); assert.match(page.svg, /<text x="164"/);
    const bytes = await renderDiffImage(page);
    const decoded = UPNG.decode(new Uint8Array(bytes).buffer);
    const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0]!);
    const offset = (70 * decoded.width + 80) * 4;
    assert.deepEqual([...pixels.slice(offset, offset + 4)], [17, 121, 231, 255], 'The real asset appears in the header, not just an unresolved image URL');
  }
  assert.equal(calls, 1, 'Current and comparison views share the same cached asset');
});

test('a long current ability keeps its icon and full description in one image', () => {
  const pages = currentImagePages([{ name: 'Talent · Long passive', heading: { type: 'Talent', name: 'Long passive', iconUrl }, value: 'A long description. '.repeat(500) + 'FINAL SENTENCE' }]);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.iconUrl, iconUrl);
  assert.match(pages[0]!.text, /FINAL\s+SENTENCE$/);
  assert.ok(!pages[0]!.text.includes('↓'));
});

test('an unavailable icon leaves a complete rendered comparison with its readable heading', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  const unavailableUrl = iconUrl.replace('a'.repeat(32), 'b'.repeat(32));
  globalThis.fetch = async input => { calls++; assert.equal(input, unavailableUrl); return new Response('Unavailable', { status: 503 }); };
  const page = diffImagePages([{ name: 'Talent · Resilience', value: '', heading: { type: 'Talent', name: 'Resilience', iconUrl: unavailableUrl },
    comparison: { before: 'Gain 100% DEF.', after: 'Gain 120% DEF.' } }])[0]!;
  const bytes = await renderDiffImage(page);
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(page.text.includes('Resilience') && page.text.includes('100%') && page.text.includes('120%'));
  assert.equal(calls, 1);
});
