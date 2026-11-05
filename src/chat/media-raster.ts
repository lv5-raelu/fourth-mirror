import { encodePNG } from 'lottie.js';

export interface MediaFrame { data: Uint8Array; mime: string; timeMs?: number }
export interface FrameRect { x: number; y: number; width: number; height: number }

export class MediaError extends Error {
  readonly reason: 'animation_limits' | 'download_failed' | 'source_unavailable' | 'decode_failed' | 'request_limit' | 'file_limit' | 'timeout';
  constructor(reason: MediaError['reason']) {
    super(reason);
    this.reason = reason;
  }
}

export function checkAnimation(width: number, height: number, frames: number): void {
  if (![width, height, frames].every(value => Number.isSafeInteger(value) && value > 0) ||
    frames > 600 || width * height > 4_000_000 || width * height * frames > 64_000_000) throw new MediaError('animation_limits');
}

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

export async function pngFrame(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, timeMs: number): Promise<MediaFrame> {
  const scale = Math.min(1, 512 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const output = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const source = (Math.min(height - 1, Math.floor(y / scale)) * width + Math.min(width - 1, Math.floor(x / scale))) * 4;
    output.set(pixels.subarray(source, source + 4), (y * w + x) * 4);
  }
  return { data: await encodePNG(output, w, h), mime: 'image/png', timeMs };
}

export function clearRect(canvas: Uint8Array, canvasWidth: number, rect: FrameRect, color: readonly number[] = [0, 0, 0, 0]): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    canvas.set(color, (y * canvasWidth + x) * 4);
  }
}

export function compositePixels(canvas: Uint8Array, canvasWidth: number, patch: Uint8Array | Uint8ClampedArray, rect: FrameRect, blend: boolean): void {
  if (patch.length !== rect.width * rect.height * 4) throw new MediaError('decode_failed');
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    const source = (y * rect.width + x) * 4, target = ((rect.y + y) * canvasWidth + rect.x + x) * 4;
    const alpha = patch[source + 3]!;
    if (!blend || alpha === 255) canvas.set(patch.subarray(source, source + 4), target);
    else if (alpha) {
      const remaining = canvas[target + 3]! * (1 - alpha / 255), combined = alpha + remaining;
      for (let channel = 0; channel < 3; channel++) canvas[target + channel] = Math.round((patch[source + channel]! * alpha + canvas[target + channel]! * remaining) / combined);
      canvas[target + 3] = Math.round(combined);
    }
  }
}
