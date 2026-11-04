import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';
import { GifReader } from 'omggif';
import UPNG from 'upng-js';
import { encodePNG, ImageSurface, parse } from 'lottie.js';

const MAX_ANIMATION_PIXELS = 8_000_000;
const MAX_ANIMATION_FRAMES = 120;

// UPNG 2.1.0 exposes its inflater. Bound output before it can allocate arbitrary
// memory from a small compressed stream; this also works in nodejs_compat Workers.
(UPNG.decode as typeof UPNG.decode & { _inflate: (data: Uint8Array) => Uint8Array })._inflate =
  data => inflateSync(data, { maxOutputLength: 16 * 1024 * 1024 });

export interface MediaFrame { data: Uint8Array; mime: string; timeMs?: number }

export function sampleFrames(delays: readonly number[], count: number): number[] {
  if (!delays.length) return [];
  const total = delays.reduce((sum, delay) => sum + delay, 0);
  const selected = new Set<number>();
  for (let sample = 0; sample < Math.min(count, delays.length); sample++) {
    const target = total * sample / Math.max(1, Math.min(count, delays.length) - 1);
    let end = 0;
    const index = delays.findIndex(delay => { end += delay; return end > target; });
    selected.add(index < 0 ? delays.length - 1 : index);
  }
  return [...selected];
}

function checkAnimation(width: number, height: number, frames: number): void {
  if (![width, height, frames].every(value => Number.isSafeInteger(value) && value > 0) ||
    frames > MAX_ANIMATION_FRAMES || width * height * frames > MAX_ANIMATION_PIXELS) throw new Error('Animation exceeds decoding limits');
}

async function pngFrame(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, timeMs: number): Promise<MediaFrame> {
  // Downsample animation frames to at most 512px. Screenshots keep their original bytes.
  const scale = Math.min(1, 512 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const output = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const source = (Math.min(height - 1, Math.floor(y / scale)) * width + Math.min(width - 1, Math.floor(x / scale))) * 4;
    output.set(pixels.subarray(source, source + 4), (y * w + x) * 4);
  }
  return { data: await encodePNG(output, w, h), mime: 'image/png', timeMs };
}

async function gifFrames(data: Uint8Array, count: number): Promise<MediaFrame[]> {
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

async function apngFrames(data: Uint8Array, count: number): Promise<MediaFrame[] | undefined> {
  const bytes = Buffer.from(data);
  let frameCount: number | undefined;
  let actualFrames = 0;
  const chunks = [bytes.subarray(0, 8)];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) throw new Error('Invalid PNG chunk');
    if ((offset === 8 && type !== 'IHDR') || (type === 'IHDR' && (offset !== 8 || length !== 13))) throw new Error('Invalid PNG header');
    if (type === 'acTL') {
      if (length !== 8 || frameCount !== undefined || actualFrames) throw new Error('Invalid APNG');
      const declaredFrames: number = bytes.readUInt32BE(offset + 8);
      checkAnimation(bytes.readUInt32BE(16), bytes.readUInt32BE(20), declaredFrames);
      frameCount = declaredFrames;
    }
    if (type === 'fcTL') {
      if (length !== 26) throw new Error('Invalid APNG frame');
      actualFrames++;
      if (frameCount === undefined || actualFrames > frameCount) throw new Error('Invalid APNG frame count');
      const width = bytes.readUInt32BE(offset + 12), height = bytes.readUInt32BE(offset + 16);
      const x = bytes.readUInt32BE(offset + 20), y = bytes.readUInt32BE(offset + 24);
      if (!width || !height || x + width > bytes.readUInt32BE(16) || y + height > bytes.readUInt32BE(20)) throw new Error('Invalid APNG bounds');
      if (bytes[offset + 32]! > 2 || bytes[offset + 33]! > 1) throw new Error('Invalid APNG composition');
    }
    // Ignore metadata. The decoder's text parsing is unnecessary for visual input.
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'acTL', 'fcTL', 'fdAT'].includes(type)) chunks.push(bytes.subarray(offset, offset + length + 12));
    if (chunks.length > 4096) throw new Error('Too many PNG chunks');
    offset += length + 12;
    if (type === 'IEND') break;
  }
  if (frameCount === undefined) return undefined;
  if (frameCount !== actualFrames) throw new Error('Invalid APNG frame count');
  checkAnimation(bytes.readUInt32BE(16), bytes.readUInt32BE(20), frameCount);
  const image = UPNG.decode(new Uint8Array(Buffer.concat(chunks)).buffer);
  const rgba = UPNG.toRGBA8(image);
  const delays = image.frames.map(frame => Math.max(20, frame.delay));
  return Promise.all(sampleFrames(delays, count).map(index => pngFrame(new Uint8Array(rgba[index]!), image.width, image.height,
    delays.slice(0, index).reduce((sum, delay) => sum + delay, 0))));
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

async function render(data: Uint8Array, kind: 'image' | 'lottie' | 'preview', count: number): Promise<MediaFrame[]> {
  if (kind === 'lottie') return lottieFrames(data, count);
  const bytes = Buffer.from(data);
  if (bytes.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return gifFrames(data, count);
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 33) throw new Error('Invalid PNG');
    return await apngFrames(data, count) ?? [{ data, mime: 'image/png' }];
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return [{ data, mime: 'image/jpeg' }];
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    // Animated WebP needs a separate decoder. Never describe a single frame as a loop.
    if (bytes[15] === 88 && (bytes[20]! & 2)) throw new Error('Animated WebP unsupported');
    return [{ data, mime: 'image/webp' }];
  }
  throw new Error('Unsupported media bytes');
}

let rendering: Promise<void> = Promise.resolve();

export async function renderMedia(data: Uint8Array, kind: 'image' | 'lottie' | 'preview', count: number, signal?: AbortSignal): Promise<MediaFrame[]> {
  // Avoid retaining several decoded animation canvases at once in a 128 MiB Worker.
  const operation = rendering.then(() => {
    signal?.throwIfAborted();
    return render(data, kind, count);
  });
  rendering = operation.then(() => {}, () => {});
  return operation;
}
