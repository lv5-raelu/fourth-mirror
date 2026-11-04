import assert from 'node:assert/strict';
import { test } from 'node:test';
import UPNG from 'upng-js';
import { allowedMediaUrl, collectDiscordMedia, MAX_MEDIA_BYTES, mediaBudget, mediaParts } from '../src/chat/media.ts';
import { renderMedia, sampleFrames } from '../src/chat/media-render.ts';
import { imageUrl, gif, png, apng, lottie, red, green, blue } from './fixtures/media.ts';

function pixels(data: Uint8Array): number[] {
  return [...new Uint8Array(UPNG.toRGBA8(UPNG.decode(new Uint8Array(data).buffer))[0]!)];
}

test('collects attachments, deduplicated custom emojis, and every Discord sticker format', () => {
  assert.deepEqual(collectDiscordMedia({ content: '😂 <:happy:123456789012345678> <:happy:123456789012345678> <a:dance:223456789012345678>',
    attachments: [{ url: imageUrl, filename: 'screen.png', size: 400 }],
  }).map(item => item.url), [imageUrl, 'https://cdn.discordapp.com/emojis/123456789012345678.webp?size=128', 'https://cdn.discordapp.com/emojis/223456789012345678.gif?size=128']);
  const stickers = collectDiscordMedia({ content: '', sticker_items: [1, 2, 3, 4].map(format_type => ({ id: '123456789012345678', name: 'Wave', format_type })) });
  assert.deepEqual(stickers.map(item => [item.kind, item.url]), [
    ['image', 'https://cdn.discordapp.com/stickers/123456789012345678.png'],
    ['lottie', 'https://cdn.discordapp.com/stickers/123456789012345678.json'],
    ['image', 'https://media.discordapp.net/stickers/123456789012345678.gif'],
  ]);
  assert.deepEqual(collectDiscordMedia({ content: '😂 💀' }), []);
});

test('rejects unsupported attachments, oversized files, excessive sources, and non-CDN URLs', () => {
  assert.throws(() => collectDiscordMedia({ content: '', attachments: [{ filename: 'audio.mp3', url: imageUrl, size: 100 }] }), /Supported attachments/);
  assert.throws(() => collectDiscordMedia({ content: '', attachments: [{ filename: 'image.png', url: imageUrl, size: MAX_MEDIA_BYTES + 1 }] }), /6 MiB/);
  assert.throws(() => collectDiscordMedia({ content: Array.from({ length: 5 }, (_, index) => `<:a:${123456789012345678n + BigInt(index)}>`).join('') }), /at most four/);
  for (const url of ['https://127.0.0.1/image.png', 'http://cdn.discordapp.com/image.png', 'https://cdn.discordapp.com.evil.test/a', 'https://user:pass@cdn.discordapp.com/a', 'https://cdn.discordapp.com:8080/a', 'file:///a', 'data:image/png;base64,abc']) assert.equal(allowedMediaUrl(url), false, url);
  assert.deepEqual(collectDiscordMedia({ content: '', attachments: [{ filename: 'file.zip' }] }, false), []);
});

test('uses allowlisted direct image links and labels static Tenor previews without fetching arbitrary pages', () => {
  const url = 'https://media.tenor.com/example/tenor.png';
  const page = 'https://tenor.com/view/wave-123';
  const media = collectDiscordMedia({ content: page + ' https://example.com/secret.png', embeds: [{ url: page, thumbnail: { url } }] });
  assert.deepEqual(media, [{ url, name: 'GIF link preview', kind: 'preview' }]);
  assert.deepEqual(collectDiscordMedia({ content: page, embeds: [{ url: page, thumbnail: { url: 'https://localhost/a.png' } }] }), []);
  assert.equal(collectDiscordMedia({ content: 'Look: ' + imageUrl })[0]?.url, imageUrl);
});

test('preserves static image bytes and samples by animation time rather than frame number', async () => {
  const bytes = await png();
  assert.deepEqual(await renderMedia(bytes, 'image', 4), [{ data: bytes, mime: 'image/png' }]);
  assert.deepEqual(sampleFrames([10, 10, 1000, 10, 10], 4), [0, 2, 4]);
  assert.deepEqual(sampleFrames([100], 4), [0]);
});

test('GIF samples composite partial frames and restore previous/background disposal correctly', async () => {
  const frames = await renderMedia(gif, 'image', 4);
  assert.deepEqual(frames.map(frame => frame.timeMs), [0, 100, 200, 300]);
  assert.deepEqual(pixels(frames[0]!.data), [...red, ...red]);
  assert.deepEqual(pixels(frames[1]!.data), [...green, ...red]);
  assert.deepEqual(pixels(frames[2]!.data), [...red, ...blue]);
  assert.deepEqual(pixels(frames[3]!.data), [...green, ...red]);
});

test('APNG frames and Lottie vectors become ordered PNG samples', async () => {
  const frames = await renderMedia(await apng(), 'image', 4);
  assert.deepEqual(frames.map(frame => frame.timeMs), [0, 100, 200]);
  assert.deepEqual(frames.map(frame => pixels(frame.data)), [red, green, blue]);
  const vector = await renderMedia(new TextEncoder().encode(JSON.stringify(lottie)), 'lottie', 4);
  assert.equal(vector.length, 4);
  assert.equal(vector[0]!.timeMs, 0);
  assert.equal(vector[3]!.timeMs, 1900);
  assert.notDeepEqual(pixels(vector[0]!.data), pixels(vector[3]!.data));
  assert.ok(pixels(vector[0]!.data).some(channel => channel > 0));
});

test('rejects unsafe or unsupported Lottie features and oversized animation canvases before rendering', async () => {
  for (const value of [{ ...lottie, assets: [{ id: 'external', p: 'https://localhost/secret' }] }, { ...lottie, layers: [{ ty: 0, refId: 'recursive' }] }, { ...lottie, w: 100000, h: 100000 }]) {
    await assert.rejects(renderMedia(new TextEncoder().encode(JSON.stringify(value)), 'lottie', 4));
  }
  const enormous = gif.slice(); enormous[6] = 255; enormous[7] = 255; enormous[8] = 255; enormous[9] = 255;
  await assert.rejects(renderMedia(enormous, 'image', 4), /limits/);
});

test('downloads without credentials, enforces streaming limits, and reports failures without leaking signed URLs', async () => {
  const source = { url: imageUrl + '?hm=private-signature', name: 'Screenshot', kind: 'image' as const };
  const bytes = await png();
  const fetcher = (async (_url, options) => {
    assert.equal(options?.redirect, 'manual'); assert.equal(options?.headers, undefined);
    return new Response(bytes);
  }) as typeof fetch;
  const budget = mediaBudget();
  const parts = await mediaParts([source], budget, AbortSignal.timeout(1000), fetcher);
  assert.equal(parts[1]?.type, 'image_url');
  assert.equal(budget.images, 11);
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://localhost/private' } }), new Response('private-signature', { status: 403 }), new Response(bytes, { headers: { 'content-length': String(MAX_MEDIA_BYTES + 1) } }), new Response(new Uint8Array(MAX_MEDIA_BYTES + 1)), new Response('not an image')]) {
    const failed = await mediaParts([source], mediaBudget(), AbortSignal.timeout(1000), (async () => response) as typeof fetch);
    assert.match(JSON.stringify(failed), /unavailable/);
    assert.doesNotMatch(JSON.stringify(failed), /private-signature|cdn\.discordapp/);
  }
  let fetched = false;
  const exhausted = await mediaParts([source], { sources: 0, images: 0, bytes: 0 }, AbortSignal.timeout(1000), (async () => { fetched = true; return new Response(); }) as typeof fetch);
  assert.equal(fetched, false); assert.match(JSON.stringify(exhausted), /omitted/);
});
