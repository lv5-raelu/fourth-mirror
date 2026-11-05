import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';
import { GifReader } from 'omggif';
import UPNG from 'upng-js';
import { ImageSurface, parse } from 'lottie.js';
import { webpFrames } from './media-webp.ts';
import { checkAnimation, clearRect, compositePixels, pngFrame, sampleFrames } from './media-raster.ts';
import type { FrameRect, MediaFrame } from './media-raster.ts';
export { sampleFrames } from './media-raster.ts';
export type { MediaFrame } from './media-raster.ts';

// UPNG 2.1.0 exposes its inflater. Bound output before it can allocate arbitrary
// memory from a small compressed stream; this also works in nodejs_compat Workers.
(UPNG.decode as typeof UPNG.decode & { _inflate: (data: Uint8Array) => Uint8Array })._inflate =
  data => inflateSync(data, { maxOutputLength: 16 * 1024 * 1024 });

async function gifFrames(data: Uint8Array, count: number, signal?: AbortSignal): Promise<MediaFrame[]> {
  // Count frames before GifReader allocates an object for each one.
  if (data.length < 13) throw new Error('Invalid GIF');
  const width = data[6]! | data[7]! << 8, height = data[8]! | data[9]! << 8;
  checkAnimation(width, height, 1);
  let offset = 13 + ((data[10]! & 128) ? 3 * (2 << (data[10]! & 7)) : 0), frameCount = 0;
  while (offset < data.length) {
    const block = data[offset++];
    if (block === 59) break;
    if (block === 44) {
      if (offset + 9 > data.length) throw new Error('Invalid GIF');
      checkAnimation(width, height, ++frameCount);
      const packed = data[offset + 8]!;
      offset += 9 + ((packed & 128) ? 3 * (2 << (packed & 7)) : 0) + 1;
    } else if (block === 33) offset++;
    else throw new Error('Invalid GIF block');
    let length: number;
    do {
      if (offset >= data.length) throw new Error('Truncated GIF');
      length = data[offset++]!;
      offset += length;
      if (offset > data.length) throw new Error('Truncated GIF');
    } while (length);
  }
  const gif = new GifReader(data);
  checkAnimation(gif.width, gif.height, gif.numFrames());
  const info = Array.from({ length: gif.numFrames() }, (_, index) => gif.frameInfo(index));
  if (info.some(frame => frame.x < 0 || frame.y < 0 || frame.x + frame.width > gif.width || frame.y + frame.height > gif.height)) throw new Error('Invalid GIF frame bounds');
  const delays = info.map(frame => Math.max(20, frame.delay * 10));
  const selected = new Set(sampleFrames(delays, count));
  let canvas = new Uint8Array(gif.width * gif.height * 4);
  const colorOffset = 13 + data[11]! * 3;
  const background = (data[10]! & 128) ? [...data.slice(colorOffset, colorOffset + 3), 255] : [0, 0, 0, 0];
  const clear = (x: number, y: number, width: number, height: number, transparent: boolean): void => {
    for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) {
      canvas.set(transparent ? [0, 0, 0, 0] : background, (row * gif.width + col) * 4);
    }
  };
  clear(0, 0, gif.width, gif.height, info[0]!.transparent_index !== null);
  let time = 0;
  const output: MediaFrame[] = [];
  for (const [index, frame] of info.entries()) {
    signal?.throwIfAborted();
    const previous = frame.disposal === 3 ? canvas.slice() : undefined;
    gif.decodeAndBlitFrameRGBA(index, canvas);
    if (selected.has(index)) output.push(await pngFrame(canvas, gif.width, gif.height, time));
    if (frame.disposal === 2) {
      clear(frame.x, frame.y, frame.width, frame.height, frame.transparent_index !== null);
    } else if (previous) canvas = previous;
    time += delays[index]!;
  }
  return output;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4); chunk.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, data.length + 8)) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return chunk;
}

async function apngFrames(data: Uint8Array, count: number, signal?: AbortSignal): Promise<MediaFrame[] | undefined> {
  const bytes = Buffer.from(data);
  let frameCount: number | undefined;
  const frames: { rect: FrameRect; delay: number; dispose: number; blend: boolean; parts: Buffer[] }[] = [];
  const shared: Buffer[] = [];
  let chunkCount = 0, ended = false;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (++chunkCount > 4096 || offset + length + 12 > bytes.length) throw new Error('Invalid PNG chunk');
    if ((offset === 8 && type !== 'IHDR') || (type === 'IHDR' && (offset !== 8 || length !== 13))) throw new Error('Invalid PNG header');
    if (type === 'acTL') {
      if (length !== 8 || frameCount !== undefined || frames.length) throw new Error('Invalid APNG');
      const declaredFrames: number = bytes.readUInt32BE(offset + 8);
      checkAnimation(width, height, declaredFrames);
      frameCount = declaredFrames;
    }
    if (type === 'fcTL') {
      if (length !== 26) throw new Error('Invalid APNG frame');
      if (frameCount === undefined || frames.length >= frameCount) throw new Error('Invalid APNG frame count');
      const rect = { width: bytes.readUInt32BE(offset + 12), height: bytes.readUInt32BE(offset + 16), x: bytes.readUInt32BE(offset + 20), y: bytes.readUInt32BE(offset + 24) };
      if (!rect.width || !rect.height || rect.x + rect.width > width || rect.y + rect.height > height) throw new Error('Invalid APNG bounds');
      const dispose = bytes[offset + 32]!, blend = bytes[offset + 33]!;
      if (dispose > 2 || blend > 1) throw new Error('Invalid APNG composition');
      const delay = bytes.readUInt16BE(offset + 28) * 1000 / (bytes.readUInt16BE(offset + 30) || 100);
      frames.push({ rect, delay: Math.max(20, Math.round(delay)), dispose, blend: Boolean(blend), parts: [] });
    }
    if (type === 'PLTE' || type === 'tRNS') shared.push(bytes.subarray(offset, offset + length + 12));
    if (type === 'IDAT' && frames.length) frames.at(-1)!.parts.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === 'fdAT') {
      if (!frames.length || length < 4) throw new Error('Invalid APNG frame data');
      frames.at(-1)!.parts.push(bytes.subarray(offset + 12, offset + 8 + length));
    }
    offset += length + 12;
    if (type === 'IEND') { ended = true; break; }
  }
  if (frameCount === undefined) return undefined;
  if (!ended || frameCount !== frames.length) throw new Error('Invalid APNG frame count');
  const selected = new Set(sampleFrames(frames.map(frame => frame.delay), count));
  let canvas = new Uint8Array(width * height * 4), time = 0;
  const output: MediaFrame[] = [];
  // Decode one frame at a time. A five-second sticker no longer requires keeping
  // hundreds of full RGBA images in memory before choosing four samples.
  for (const [index, frame] of frames.entries()) {
    signal?.throwIfAborted();
    if (!frame.parts.length) throw new Error('Missing APNG frame pixels');
    const header = Buffer.from(bytes.subarray(16, 29));
    header.writeUInt32BE(frame.rect.width); header.writeUInt32BE(frame.rect.height, 4);
    const standalone = Buffer.concat([bytes.subarray(0, 8), pngChunk('IHDR', header), ...shared,
      ...frame.parts.map(part => pngChunk('IDAT', part)), pngChunk('IEND')]);
    const image = UPNG.decode(new Uint8Array(standalone).buffer);
    const patch = new Uint8Array(UPNG.toRGBA8(image)[0]!);
    const previous = frame.dispose === 2 ? canvas.slice() : undefined;
    compositePixels(canvas, width, patch, frame.rect, frame.blend);
    if (selected.has(index)) output.push(await pngFrame(canvas, width, height, time));
    if (frame.dispose === 1) clearRect(canvas, width, frame.rect);
    else if (previous) canvas = previous;
    time += frame.delay;
  }
  return output;
}

async function lottieFrames(data: Uint8Array, count: number): Promise<MediaFrame[]> {
  if (data.length > 512 * 1024) throw new Error('Lottie too large');
  const json: unknown = JSON.parse(new TextDecoder().decode(data));
  // Bound nesting/complexity and reject expressions, image assets, precompositions,
  // repeaters, text and effects that could silently render incompletely or recurse.
  const pending = [{ value: json, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 12_000 || depth > 32) throw new Error('Lottie too complex');
    if (!value || typeof value !== 'object') continue;
    const object = value as Record<string, unknown>;
    if (typeof object.x === 'string' || object.ty === 0 || object.ty === 2 || object.ty === 5 || object.ty === 'rp' ||
      (Array.isArray(object.ef) && object.ef.length) || (Array.isArray(object.assets) && object.assets.length)) throw new Error('Unsupported Lottie feature');
    for (const child of Object.values(object)) pending.push({ value: child, depth: depth + 1 });
  }
  const animation = parse(json as Parameters<typeof parse>[0]);
  if (!Number.isFinite(animation.frameRate) || animation.frameRate <= 0 || !Number.isFinite(animation.duration) || animation.duration <= 0 || animation.duration > 10) throw new Error('Invalid Lottie timeline');
  checkAnimation(animation.width, animation.height, 1);
  const width = Math.max(1, Math.round(animation.width * Math.min(1, 256 / Math.max(animation.width, animation.height))));
  const height = Math.max(1, Math.round(animation.height * width / animation.width));
  const surface = new ImageSurface(width, height);
  try {
    return await Promise.all(Array.from({ length: count }, (_, index) => {
      const frame = animation.inPoint + (animation.totalFrames - 1) * index / Math.max(1, count - 1);
      const image = surface.render(animation, frame);
      return pngFrame(image.data, image.width, image.height, Math.round((frame - animation.inPoint) * 1000 / animation.frameRate));
    }));
  } finally { surface.dispose(); }
}

async function render(data: Uint8Array, kind: 'image' | 'lottie' | 'preview', count: number, signal?: AbortSignal): Promise<MediaFrame[]> {
  if (kind === 'lottie') return lottieFrames(data, count);
  const bytes = Buffer.from(data);
  if (bytes.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return gifFrames(data, count, signal);
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 33) throw new Error('Invalid PNG');
    return await apngFrames(data, count, signal) ?? [{ data, mime: 'image/png' }];
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return [{ data, mime: 'image/jpeg' }];
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return await webpFrames(data, count, signal) ?? [{ data, mime: 'image/webp' }];
  }
  throw new Error('Unsupported media bytes');
}

let rendering: Promise<void> = Promise.resolve();

export async function renderMedia(data: Uint8Array, kind: 'image' | 'lottie' | 'preview', count: number, signal?: AbortSignal): Promise<MediaFrame[]> {
  // Avoid retaining several decoded animation canvases at once in a 128 MiB Worker.
  const operation = rendering.then(() => {
    signal?.throwIfAborted();
    return render(data, kind, count, signal);
  });
  rendering = operation.then(() => {}, () => {});
  return operation;
}
