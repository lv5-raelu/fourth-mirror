const MAX_BYTES = 256 * 1024;
const CACHE_MS = 5 * 60_000;
export const isBetaIconUrl = (value: unknown): value is string => typeof value === 'string' && /^https:\/\/cdn\.gachabase\.net\/hsr\/assets\/[a-f0-9]{32}\.png$/.test(value);

/** Only small, content-addressed GachaBase PNG assets can enter the renderer. */
export class BetaIconClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, { until: number; promise: Promise<Uint8Array | undefined> }>();
  constructor(request: typeof fetch = (input, init) => fetch(input, init), now: () => number = Date.now) { this.request = request; this.now = now; }

  async load(url: string): Promise<Uint8Array | undefined> {
    if (!isBetaIconUrl(url)) return undefined;
    const cached = this.cache.get(url);
    if (cached && cached.until > this.now()) return cached.promise;
    const entry = { until: this.now() + CACHE_MS, promise: Promise.resolve<Uint8Array | undefined>(undefined) };
    entry.promise = this.download(url).catch(() => { entry.until = this.now() + 30_000; return undefined; });
    this.cache.set(url, entry);
    if (this.cache.size > 48) this.cache.delete(this.cache.keys().next().value!);
    return entry.promise;
  }

  private async download(url: string): Promise<Uint8Array> {
    const response = await this.request(url, { redirect: 'manual', signal: AbortSignal.timeout(3_000) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Icon unavailable.'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.length; if (length > MAX_BYTES) throw new Error('Icon too large.');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (length < 24 || [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].some((value, index) => bytes[index] !== value)) throw new Error('Invalid icon PNG.');
    const view = new DataView(bytes.buffer);
    const width = view.getUint32(16), height = view.getUint32(20);
    if (!width || !height || width > 512 || height > 512) throw new Error('Icon dimensions exceed the rendering limit.');
    return bytes;
  }
}

export const betaIcons = new BetaIconClient();
