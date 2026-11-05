import assert from 'node:assert/strict';
import { test } from 'node:test';
import UPNG from 'upng-js';
import { allowedMediaUrl, collectDiscordMedia, MAX_MEDIA_BYTES, mediaBudget, mediaParts } from '../src/chat/media.ts';
import { renderMedia, sampleFrames } from '../src/chat/media-render.ts';
import { imageUrl, gif, png, apng, lottie, red, green, blue, webp, lossyWebp } from './fixtures/media.ts';
import { encodeAPNG } from 'lottie.js';

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

test('collects GIF pages for source resolution and accepts the supported FxTwitter/CDN image links', () => {
  const url = 'https://media.tenor.com/example/tenor.png';
  const page = 'https://tenor.com/view/wave-123';
  const media = collectDiscordMedia({ content: page + ' https://example.com/secret.png', embeds: [{ url: page, thumbnail: { url } }] });
  assert.deepEqual(media, [{ url: page, name: 'Linked GIF', kind: 'gif-page', previewUrl: url }]);
  assert.deepEqual(collectDiscordMedia({ content: page, embeds: [{ url: page, thumbnail: { url: 'https://localhost/a.png' } }] }), [{ url: page, name: 'Linked GIF', kind: 'gif-page' }]);
  assert.equal(collectDiscordMedia({ content: 'Look: ' + imageUrl })[0]?.url, imageUrl);
  assert.equal(collectDiscordMedia({ content: 'https://gif.fxtwitter.com/tweet_video/HUOyQ56XcAAYspD.webp' })[0]?.kind, 'image');
  assert.equal(allowedMediaUrl('https://gif.fxtwitter.com.evil.test/a.webp'), false);
});

test('animated WebP decodes lossless and lossy frame bitstreams with timestamps and partial-frame composition', async () => {
  const frames = await renderMedia(webp, 'image', 4);
  assert.deepEqual(frames.map(frame => frame.timeMs), [0, 100, 200, 300]);
  assert.deepEqual(pixels(frames[0]!.data), [...red, ...red]);
  assert.deepEqual(pixels(frames[1]!.data), [...green, ...red]);
  assert.deepEqual(pixels(frames[2]!.data), [...red, ...blue]);
  const lossy = await renderMedia(lossyWebp, 'image', 4);
  assert.equal(lossy.length, 4);
  assert.notDeepEqual(pixels(lossy[0]!.data), pixels(lossy[2]!.data));
  const malformed = Buffer.from(webp);
  malformed.writeUIntLE(0xffffff, 24, 3);
  await assert.rejects(renderMedia(malformed, 'image', 4), /limits/);
});

test('WebP alpha blending, source replacement, and background disposal preserve the displayed pixels', async () => {
  const redFile = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA', 'base64');
  const blueFile = Buffer.from('UklGRloAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAgFZQOCAyAAAA8AEAnQEqAQABAADAEiWgAnS6AfgABEwAAP7+ZqH/+tHP10T/Wjn/rRz/5SqLVNuKAAA=', 'base64');
  const frame = (data: Buffer, flags: number): Buffer => {
    const chunk = Buffer.alloc(24);
    chunk.write('ANMF'); chunk.writeUInt32LE(16 + data.length, 4); chunk.writeUIntLE(100, 20, 3); chunk[23] = flags;
    return Buffer.concat([chunk, data]);
  };
  const extended = Buffer.alloc(18); extended.write('VP8X'); extended.writeUInt32LE(10, 4); extended[8] = 18;
  const anim = Buffer.alloc(14); anim.write('ANIM'); anim.writeUInt32LE(6, 4); anim.set([0, 0, 255, 255], 8);
  const body = Buffer.concat([Buffer.from('WEBP'), extended, anim, frame(redFile.subarray(12), 2),
    frame(blueFile.subarray(30), 0), frame(blueFile.subarray(30), 3), frame(blueFile.subarray(30), 0)]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  const frames = await renderMedia(Buffer.concat([header, body]), 'image', 4);
  assert.deepEqual(pixels(frames[0]!.data), red);
  const blended = pixels(frames[1]!.data), replaced = pixels(frames[2]!.data), restored = pixels(frames[3]!.data);
  assert.ok(Math.abs(blended[0]! - 127) <= 2 && Math.abs(blended[2]! - 128) <= 2);
  assert.equal(blended[3], 255);
  assert.equal(replaced[3], 128);
  assert.deepEqual(restored, blended);
});

test('normal-length APNG stickers exceeding the old eight-million-pixel limit decode without retaining all frames', async () => {
  const rgba = new Uint8Array(320 * 320 * 4);
  for (let index = 0; index < rgba.length; index += 4) rgba.set(red, index);
  const data = await encodeAPNG(Array.from({ length: 90 }, () => rgba), 320, 320, { fps: 30 });
  const frames = await renderMedia(data, 'image', 4);
  assert.equal(frames.length, 4);
  assert.deepEqual(frames.map(frame => frame.timeMs), [0, 990, 1980, 2937]);
  assert.equal(UPNG.decode(new Uint8Array(frames[0]!.data).buffer).width, 320);
});

test('GIF page metadata resolves the original animation and cannot redirect downloads to a private host', async () => {
  const page = 'https://tenor.com/view/wave-123';
  const url = 'https://media1.tenor.com/m/example/wave.webp';
  const media = collectDiscordMedia({ content: page });
  const seen: string[] = [];
  const fetcher = (async (input, options) => {
    seen.push(String(input)); assert.equal(options?.headers, undefined);
    return String(input) === page ? new Response(`<meta content="${url}" property="og:image"><img src="https://media.tenor.com/unrelated.gif">`)
      : new Response(webp);
  }) as typeof fetch;
  const parts = await mediaParts(media, mediaBudget(), AbortSignal.timeout(1000), fetcher);
  assert.equal(parts.filter(part => part.type === 'image_url').length, 4);
  assert.deepEqual(seen, [page, url]);
  const calls: string[] = [];
  const denied = await mediaParts(media, mediaBudget(), AbortSignal.timeout(1000), (async input => {
    calls.push(String(input)); return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  }) as typeof fetch);
  assert.deepEqual(calls, [page]); assert.match(JSON.stringify(denied), /unavailable/);
  const preview = 'https://media.tenor.com/example/poster.png';
  const image = await png();
  const still = await mediaParts(collectDiscordMedia({ content: page, embeds: [{ url: page, thumbnail: { url: preview } }] }), mediaBudget(), AbortSignal.timeout(1000),
    (async input => String(input) === page ? new Response('<img src="https://media.tenor.com/unrelated.gif">') : new Response(image)) as typeof fetch);
  assert.equal(still.filter(part => part.type === 'image_url').length, 1);
  assert.match(JSON.stringify(still), /static preview only/);
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
