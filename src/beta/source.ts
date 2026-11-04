import { unflatten } from 'devalue';
import { ChatError } from '../chat/types.ts';
import type { SourceContext } from '../chat/types.ts';
import type { BetaEntity, BetaFeed, BetaRevision } from './types.ts';

export const BETA_ORIGIN = 'https://hsr.gachabase.net';
export const BETA_URL = BETA_ORIGIN + '/changelog/beta?lang=en';
const CACHE_MS = 5 * 60_000;
const categories = { characters: 'Characters', lightcones: 'Light Cones', relics: 'Cavern Relics', planarOrnaments: 'Planar Ornaments', items: 'Items' };
const versionPattern = /^\d+\.\d+\.\d+$/;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const number = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : -1;

export function plainText(value: string): string {
  return value.replace(/<\/?[a-z][^>]*>/gi, '').replace(/\\n/g, '\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = new URL(value, BETA_ORIGIN);
  if (url.origin !== BETA_ORIGIN || url.username || url.password ||
    !/^\/(?:diff\/)?(?:characters|lightcones|relics|planar-ornaments|items)\/\d+\/[a-z0-9-]+(?:\/beta(?:\/\d+\.\d+\.\d+\/\d+)?)?$/.test(url.pathname)) return undefined;
  for (const key of [...url.searchParams.keys()]) if (!['prev', 'cur'].includes(key)) url.searchParams.delete(key);
  for (const value of url.searchParams.values()) if (!/^beta_\d+\.\d+\.\d+_\d+$/.test(value)) return undefined;
  url.searchParams.set('lang', 'en');
  url.hash = '';
  return url.href;
}

export function decodePage(body: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  for (const line of body.trim().split('\n').slice(0, 24)) {
    const packet = record(JSON.parse(line));
    const tables = packet?.type === 'chunk' ? [packet.data] : Array.isArray(packet?.nodes)
      ? packet.nodes.map(node => record(node)?.data).filter(Array.isArray) : [];
    for (const table of tables) {
      if (!Array.isArray(table)) continue;
      const value = record(unflatten(table, { Promise: () => null }));
      if (value) values.push(value);
    }
  }
  return values;
}

export function compareRevisions(a: BetaRevision, b: BetaRevision): number {
  const left = a.version.split('.').map(Number), right = b.version.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return a.revision - b.revision;
}

export function parseFeed(body: string, checkedAt: number): BetaFeed {
  const data = decodePage(body).map(value => record(value.data)).find(value => Array.isArray(value?.revisions));
  if (!data || !Array.isArray(data.revisions)) throw new Error('Missing beta changelog.');
  const revisions: BetaRevision[] = [];
  for (const raw of data.revisions.slice(0, 30)) {
    const entry = record(raw), revision = record(entry?.revision);
    if (!entry || revision?.branch !== 'beta' || typeof revision.version !== 'string' || !versionPattern.test(revision.version) || number(revision.design_revision) < 0) continue;
    const entities: BetaEntity[] = [];
    for (const [key, category] of Object.entries(categories)) {
      if (!Array.isArray(entry[key])) continue;
      for (const rawEntity of (entry[key] as unknown[]).slice(0, 250)) {
        const entity = record(rawEntity), name = record(entity?.name);
        const url = sourceUrl(entity?.href), diffUrl = sourceUrl(entity?.diff);
        const text = typeof name?.override === 'string' && name.override ? name.override : name?.text;
        if (!entity || number(entity.id) < 0 || typeof text !== 'string' || !url || !['new', 'updated', 'removed'].includes(String(entity.status))) continue;
        entities.push({ id: entity.id as number, name: plainText(text).slice(0, 120), category, status: String(entity.status), url, ...(diffUrl ? { diffUrl } : {}) });
      }
    }
    const publishedAt = number(revision.design_timestamp);
    revisions.push({ key: `beta_${revision.version}_${revision.design_revision}`, version: revision.version, revision: revision.design_revision as number,
      resourceRevision: Math.max(0, number(revision.resource_revision)), entities, ...(publishedAt > 0 ? { publishedAt: publishedAt * 1_000 } : {}),
    });
  }
  revisions.sort((a, b) => compareRevisions(b, a));
  const unique = revisions.filter((revision, index) => revisions.findIndex(value => value.key === revision.key) === index);
  if (!unique.length) throw new Error('No valid beta revisions.');
  return { checkedAt, revisions: unique };
}

function flattenDetails(value: unknown, prefix = '', result = new Map<string, string>(), depth = 0): Map<string, string> {
  if (result.size > 5_000 || depth > 14) return result;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = typeof value === 'string' ? plainText(value) : String(value);
    if (text) result.set(prefix, text.slice(0, 1_000));
  } else if (Array.isArray(value)) {
    value.slice(0, 150).forEach((item, index) => flattenDetails(item, `${prefix}[${number(record(item)?.id) >= 0 ? 'id=' + record(item)!.id : index}]`, result, depth + 1));
  } else if (record(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/(?:hash|asset|icon|sprite|portrait|texture|profile|skin|build_recommendation)/i.test(key) || ['key', 'override'].includes(key)) continue;
      flattenDetails(item, prefix ? `${prefix}.${key}` : key, result, depth + 1);
    }
  }
  return result;
}

export function parseDetails(body: string): { from: unknown; to: unknown; changes: { field: string; before: string | null; after: string | null }[]; current: { field: string; value: string }[] } {
  const data = decodePage(body).map(value => record(value.data)).find(value => record(value?.target)?.dto || value?.dto || value?.id);
  if (!data) throw new Error('Missing beta entity data.');
  const before = flattenDetails(record(data.source)?.dto);
  const after = flattenDetails(record(data.target)?.dto ?? data.dto ?? data);
  if (!after.size) throw new Error('Missing beta entity details.');
  const changes = [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key))
    .slice(0, 100).map(field => ({ field, before: before.get(field) ?? null, after: after.get(field) ?? null }));
  const identity = (value: unknown): unknown => {
    const ident = record(value);
    if (!ident) return null;
    if (ident.branch !== 'beta') throw new Error('Unexpected non-beta comparison.');
    return { version: ident.version, revision: ident.revision, branch: ident.branch };
  };
  return { from: identity(data.sourceIdent), to: identity(data.targetIdent), changes: before.size ? changes : [],
    current: [...after].slice(0, 120).map(([field, value]) => ({ field, value })) };
}

export class BetaClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private cached: BetaFeed | undefined;
  private inflight: Promise<BetaFeed> | undefined;
  private retryAt = 0;
  private readonly details = new Map<string, { at: number; promise: Promise<ReturnType<typeof parseDetails>> }>();
  constructor(request: typeof fetch = (input, init) => fetch(input, init), now: () => number = Date.now) { this.request = request; this.now = now; }

  private async data(url: string, signal?: AbortSignal): Promise<string> {
    const parsed = new URL(url);
    if (parsed.origin !== BETA_ORIGIN || (parsed.pathname !== '/changelog/beta' && !sourceUrl(url))) throw new Error('Invalid beta source URL.');
    parsed.pathname += '/__data.json';
    parsed.searchParams.set('lang', 'en');
    const timeout = AbortSignal.timeout(10_000);
    const response = await this.request(parsed, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'text/sveltekit-data, application/json' } });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Beta source unavailable.'); }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, body = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error('Beta source response too large.');
        body += decoder.decode(chunk.value, { stream: true });
      }
      return body + decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async feed(force = false, signal?: AbortSignal): Promise<BetaFeed> {
    if (!force && this.cached && this.now() - this.cached.checkedAt < CACHE_MS) return this.cached;
    if (this.inflight) return this.inflight;
    if (this.now() < this.retryAt) {
      if (!force && this.cached) return { ...this.cached, stale: true };
      throw new ChatError('Gachabase is unavailable right now. Please try again shortly.');
    }
    this.inflight = (async () => {
      try {
        const feed = parseFeed(await this.data(BETA_URL, signal), this.now());
        this.cached = feed;
        return feed;
      } catch {
        this.retryAt = this.now() + 30_000;
        if (!force && this.cached) return { ...this.cached, stale: true };
        throw new ChatError('I couldn’t read the beta archive on Gachabase. Please try again shortly.');
      } finally { this.inflight = undefined; }
    })();
    return this.inflight;
  }

  async question(question: string): Promise<{ feed: BetaFeed; source: SourceContext }> {
    const signal = AbortSignal.timeout(12_000);
    const feed = await this.feed(false, signal);
    const normalized = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
    const input = normalized(question);
    const pool = new Map<string, BetaEntity>();
    for (const revision of feed.revisions) for (const entity of revision.entities) if (!pool.has(entity.category + entity.id)) pool.set(entity.category + entity.id, entity);
    const stopWords = new Set(['the', 'for', 'and', 'with', 'from', 'this', 'that', 'light', 'cone', 'star']);
    // Prefer the newest appearance of each entity, then match names explicitly mentioned in the question.
    const words = new Set(input.split(' '));
    const matches = [...pool.values()].map(entity => {
      const name = normalized(entity.name), tokens = name.split(' ').filter(word => word.length >= 3 && !stopWords.has(word));
      const hits = tokens.filter(word => words.has(word)).length;
      const score = (' ' + input + ' ').includes(' ' + name + ' ') ? 1_000 + name.length : words.has(String(entity.id)) ? 800 : tokens.length ? hits / tokens.length * 100 : 0;
      return { entity, score };
    }).filter(value => value.score > 0).sort((a, b) => b.score - a.score).slice(0, 2).map(value => value.entity);
    const details = await Promise.all(matches.map(async entity => {
      const url = entity.diffUrl ?? entity.url;
      try {
        let cached = this.details.get(url);
        if (!cached || this.now() - cached.at > CACHE_MS) {
          const promise = this.data(url, signal).then(parseDetails);
          cached = { at: this.now(), promise };
          this.details.set(url, cached);
          if (this.details.size > 30) this.details.delete(this.details.keys().next().value!);
          void promise.catch(() => this.details.delete(url));
        }
        const parsed = await cached.promise;
        const compact = { name: entity.name, url, from: parsed.from, to: parsed.to, changes: parsed.changes.slice(0, 40), current: parsed.current.slice(0, 40) };
        while (JSON.stringify(compact).length > 8_000 && compact.current.length) compact.current.pop();
        while (JSON.stringify(compact).length > 8_000 && compact.changes.length > 1) compact.changes.pop();
        return compact;
      } catch { return { name: entity.name, url, unavailable: true }; }
    }));
    const content = JSON.stringify({ source: 'Gachabase HSR beta archive; unofficial and subject to change', checkedAt: new Date(feed.checkedAt).toISOString(), stale: Boolean(feed.stale),
      revisions: feed.revisions.slice(0, 4).map(revision => ({ version: revision.version, designRevision: revision.revision, entities: revision.entities.slice(0, 12).map(entity => ({ name: entity.name, category: entity.category, status: entity.status })) })),
      details, coverage: 'Only these revisions and matched entity details were retrieved. An updated entry alone does not establish a buff or nerf. Numeric IDs and tooltip references are not stat percentages or damage values. Missing values are unknown, not zero. Some long details and revision listings may be truncated.' });
    return { feed, source: { title: 'Honkai: Star Rail beta archive', url: BETA_URL, content, checkedAt: feed.checkedAt } };
  }

  async verify(): Promise<{ version: string; revision: number; entities: number; comparisonFields: number }> {
    const feed = await this.feed(true);
    const latest = feed.revisions[0]!;
    const entity = latest.entities.find(value => value.diffUrl);
    const details = entity ? parseDetails(await this.data(entity.diffUrl!)) : undefined;
    return { version: latest.version, revision: latest.revision, entities: latest.entities.length, comparisonFields: details?.changes.length ?? 0 };
  }
}
