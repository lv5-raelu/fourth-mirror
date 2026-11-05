import { Buffer } from 'node:buffer';
import { decodeWebp } from './webp-decoder.ts';
import { checkAnimation, clearRect, compositePixels, pngFrame, sampleFrames } from './media-raster.ts';
import type { FrameRect, MediaFrame } from './media-raster.ts';

interface Chunk { type: string; bytes: Buffer; data: Buffer }
function chunks(bytes: Buffer, start: number, end: number): Chunk[] {
  const result: Chunk[] = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end || result.length >= 4096) throw new Error('Invalid WebP chunks');
    const size = bytes.readUInt32LE(offset + 4), next = offset + 8 + size + (size & 1);
    if (next > end) throw new Error('Truncated WebP chunk');
    result.push({ type: bytes.toString('ascii', offset, offset + 4), bytes: bytes.subarray(offset, next), data: bytes.subarray(offset + 8, offset + 8 + size) });
    offset = next;
  }
  return result;
}

function stillFrame(data: Buffer, rect: FrameRect): Uint8Array {
  const parts = chunks(data, 0, data.length).filter(chunk => ['VP8 ', 'VP8L', 'ALPH'].includes(chunk.type));
  const images = parts.filter(chunk => chunk.type !== 'ALPH');
  if (images.length !== 1) throw new Error('Invalid WebP frame');
  const image = images[0]!;
  let width: number, height: number;
  if (image.type === 'VP8L') {
    if (image.data.length < 5 || image.data[0] !== 47) throw new Error('Invalid lossless WebP');
    const bits = image.data.readUInt32LE(1);
    width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;
  } else {
    if (image.data.length < 10 || image.data.toString('hex', 3, 6) !== '9d012a') throw new Error('Invalid lossy WebP');
    width = image.data.readUInt16LE(6) & 16383; height = image.data.readUInt16LE(8) & 16383;
  }
  // Check the bitstream itself before the native decoder allocates its image.
  if (width !== rect.width || height !== rect.height) throw new Error('Mismatched WebP frame dimensions');
  const header = Buffer.alloc(18);
  header.write('VP8X', 0); header.writeUInt32LE(10, 4); header[8] = 16;
  header.writeUIntLE(width - 1, 12, 3); header.writeUIntLE(height - 1, 15, 3);
  const body = Buffer.concat([Buffer.from('WEBP'), header, ...parts.map(part => part.bytes)]);
  const riff = Buffer.alloc(8); riff.write('RIFF'); riff.writeUInt32LE(body.length, 4);
  return new Uint8Array(Buffer.concat([riff, body]));
}

export async function webpFrames(data: Uint8Array, count: number, signal?: AbortSignal): Promise<MediaFrame[] | undefined> {
  const bytes = Buffer.from(data);
  if (bytes.length < 12 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Invalid WebP size');
  const parts = chunks(bytes, 12, bytes.length);
  const extended = parts.find(part => part.type === 'VP8X');
  if (!extended || extended.data.length !== 10 || !(extended.data[0]! & 2)) return undefined;
  const width = extended.data.readUIntLE(4, 3) + 1, height = extended.data.readUIntLE(7, 3) + 1;
  const animation = parts.find(part => part.type === 'ANIM');
  if (!animation || animation.data.length !== 6) throw new Error('Missing WebP animation header');
  const background = [animation.data[2]!, animation.data[1]!, animation.data[0]!, animation.data[3]!];
  const frames = parts.filter(part => part.type === 'ANMF');
  checkAnimation(width, height, frames.length);
  const descriptors = frames.map(({ data }) => {
    if (data.length < 16) throw new Error('Invalid animated WebP frame');
    const rect = { x: data.readUIntLE(0, 3) * 2, y: data.readUIntLE(3, 3) * 2, width: data.readUIntLE(6, 3) + 1, height: data.readUIntLE(9, 3) + 1 };
    if (rect.x + rect.width > width || rect.y + rect.height > height) throw new Error('Invalid WebP frame bounds');
    const imageData = data.subarray(16), imageChunks = chunks(imageData, 0, imageData.length);
    const bitstream = imageChunks.find(chunk => chunk.type === 'VP8 ' || chunk.type === 'VP8L');
    const opaque = !imageChunks.some(chunk => chunk.type === 'ALPH') && (bitstream?.type === 'VP8 ' ||
      (bitstream?.type === 'VP8L' && bitstream.data.length >= 5 && !(bitstream.data[4]! & 16)));
    const blend = !(data[15]! & 2);
    const independent = rect.x === 0 && rect.y === 0 && rect.width === width && rect.height === height && (!blend || opaque);
    return { rect, delay: Math.max(20, data.readUIntLE(12, 3)), dispose: Boolean(data[15]! & 1), blend, independent, data: imageData };
  });
  const selected = new Set(sampleFrames(descriptors.map(frame => frame.delay), count));
  const needed = new Set<number>();
  for (const target of selected) {
    let start = target;
    while (start > 0 && !descriptors[start]!.independent) start--;
    for (let index = start; index <= target; index++) needed.add(index);
  }
  const canvas = new Uint8Array(width * height * 4);
  clearRect(canvas, width, { x: 0, y: 0, width, height }, background);
  const output: MediaFrame[] = [];
  let time = 0;
  for (const [index, frame] of descriptors.entries()) {
    signal?.throwIfAborted();
    // Full opaque/source frames replace the canvas: skip unrelated frames before
    // such a sample, while preserving every prerequisite for delta/alpha frames.
    if (!needed.has(index)) { time += frame.delay; continue; }
    const pixels = await decodeWebp(stillFrame(frame.data, frame.rect));
    compositePixels(canvas, width, pixels.data, frame.rect, frame.blend);
    if (selected.has(index)) output.push(await pngFrame(canvas, width, height, time));
    if (frame.dispose) clearRect(canvas, width, frame.rect, background);
    time += frame.delay;
  }
  return output;
}
