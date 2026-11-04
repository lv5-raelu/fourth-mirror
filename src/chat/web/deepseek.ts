import { Buffer } from 'node:buffer';
import type { WebConfig } from '../../config-values.ts';
import { publicWebUrl, WebError } from './types.ts';
import type { WebPage, WebProvider, WebSource } from './types.ts';

export class DeepSeekWebProvider implements WebProvider {
  readonly #config: WebConfig;

  constructor(config: WebConfig) {
    this.#config = config;
  }

  async search(query: string, signal: AbortSignal): Promise<readonly WebSource[]> {
    const data = await this.#post('search', { query, count: 5, need_content: false }, signal);
    if (!Array.isArray(data.results)) throw new WebError('The search service returned an invalid response.');
    const sources: WebSource[] = [];
    for (const value of data.results.slice(0, 5) as unknown[]) {
      if (!isRecord(value) || typeof value.url !== 'string') continue;
      try {
        sources.push({
          url: publicWebUrl(value.url),
          title: typeof value.title === 'string' ? value.title.slice(0, 160) : '',
          summary: String(value.summary || value.snippet || '').slice(0, 1000),
          publishedAt: typeof value.date === 'string' ? value.date : null,
        });
      } catch { /* Skip non-public result URLs. */ }
    }
    return sources;
  }

  async fetchPage(value: string, signal: AbortSignal): Promise<WebPage> {
    const url = publicWebUrl(value);
    const data = await this.#post('fetch', { url }, signal);
    if (typeof data.content !== 'string' || !data.content.trim()) throw new WebError('No readable page content was returned.');
    return { url, title: typeof data.title === 'string' ? data.title.slice(0, 160) : '', content: data.content.slice(0, 8000) };
  }

  async #post(path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(this.#config.baseUrl + '/' + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.#config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        // Workers supports manual redirects; never follow a service redirect with its API key.
        redirect: 'manual',
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 300 && response.status < 400) throw new WebError('The web lookup failed because the service redirected the request.');
        if ([401, 402, 429].includes(response.status)) throw new WebError('The web service is unavailable or has reached its usage limit.');
        throw new WebError('The web service could not retrieve results. The page may be unavailable or block access.');
      }
      const data: unknown = await readLimitedJson(response);
      if (!isRecord(data)) throw new WebError('The web service returned an invalid response.');
      return data;
    } catch (error) {
      if (error instanceof WebError) throw error;
      // Never forward upstream error bodies, authorization headers, or network diagnostics to the model.
      throw new WebError('The web lookup failed or timed out.');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new WebError('The web service returned an empty response.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) throw new WebError('The web response was too large to read.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
