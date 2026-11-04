import type { BetaMessage } from '../../src/beta/types.ts';

export class DiscordError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Discord request failed (${status}).`); this.status = status; }
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export const allowedMentions = { parse: [], replied_user: false };

export class DiscordRest {
  private queue: Promise<unknown> = Promise.resolve();
  private globalUntil = 0;
  private blocked = new Map<string, number>();
  private buckets = new Map<string, string>();

  private readonly token: string;
  constructor(token: string) { this.token = token; }

  request<T = Record<string, unknown>>(method: string, path: string, body?: unknown,
    options: { deadlineMs?: number; immediate?: boolean; auth?: boolean; query?: Readonly<Record<string, string | number>>; signal?: AbortSignal } = {}): Promise<T> {
    // Start the deadline at admission, not after waiting for the queue.
    const deadline = Date.now() + (options.deadlineMs ?? 20_000);
    const task = (): Promise<T> => this.execute(method, path, body, deadline, options.auth !== false, options.query, options.signal);
    if (options.immediate) return task();
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }

  private async execute<T>(method: string, path: string, body: unknown, deadline: number, auth: boolean, query?: Readonly<Record<string, string | number>>, signal?: AbortSignal): Promise<T> {
    if (!path.startsWith('/') || path.includes('://') || path.includes('?') || path.includes('#')) throw new Error('Invalid Discord route.');
    const url = new URL('https://discord.com/api/v10' + path);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
    const parts = path.split('/');
    const major = ['channels', 'guilds', 'webhooks'].includes(parts[1] ?? '') ? parts.slice(1, parts[1] === 'webhooks' ? 4 : 3).join('/') : 'none';
    const route = method + ' ' + path.replace(/\d{17,20}/g, ':id').replace(/\/webhooks\/[^/]+\/[^/]+/, '/webhooks/:id/:token').replace(/\/interactions\/[^/]+\/[^/]+/, '/interactions/:id/:token') + ' ' + major;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (Date.now() >= deadline || signal?.aborted) throw new DiscordError(408);
      const bucket = this.buckets.get(route) ?? route;
      const delay = Math.max(this.globalUntil, this.blocked.get(bucket) ?? 0) - Date.now();
      if (Date.now() + Math.max(0, delay) >= deadline) throw new DiscordError(429);
      if (delay > 0) await wait(delay);
      if (Date.now() >= deadline || signal?.aborted) throw new DiscordError(408);
      const response = await fetch(url, {
        method, headers: {
          ...(auth ? { Authorization: 'Bot ' + this.token } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
          : AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      const bucketId = response.headers.get('X-RateLimit-Bucket');
      if (this.buckets.size > 2048) this.buckets.clear();
      if (this.blocked.size > 2048) for (const [name, until] of this.blocked) if (until <= Date.now()) this.blocked.delete(name);
      const key = bucketId ? bucketId + ' ' + major : bucket;
      if (bucketId) this.buckets.set(route, key);
      const reset = Number(response.headers.get('X-RateLimit-Reset-After'));
      if (response.headers.get('X-RateLimit-Remaining') === '0' && Number.isFinite(reset) && reset >= 0) {
        this.blocked.set(key, Date.now() + reset * 1000 + 50);
      }
      if (response.status === 429) {
        const value = await response.json() as { retry_after?: number; global?: boolean };
        const seconds = Number(value.retry_after ?? response.headers.get('Retry-After') ?? 1);
        const until = Date.now() + (Number.isFinite(seconds) && seconds >= 0 ? seconds : 1) * 1000 + 50;
        if (value.global) this.globalUntil = until;
        else this.blocked.set(key, until);
        continue; // Discord explicitly rejected this operation; other failures are never retried.
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new DiscordError(response.status);
      }
      if (response.status === 204) return undefined as T;
      return await response.json() as T;
    }
    throw new DiscordError(429);
  }

  async message(channelId: string, content: string, nonce: string, deadlineMs = 20_000, replyTo?: string): Promise<void> {
    // SuppressEmbeds keeps conversational source links from creating large preview cards.
    await this.request('POST', `/channels/${channelId}/messages`, { content, flags: 4, allowed_mentions: allowedMentions, nonce, enforce_nonce: true,
      ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
    }, { deadlineMs });
  }

  async richMessage(channelId: string, payload: BetaMessage, nonce: string, deadlineMs = 20_000): Promise<void> {
    await this.request('POST', `/channels/${channelId}/messages`, { ...payload, allowed_mentions: allowedMentions, nonce, enforce_nonce: true }, { deadlineMs });
  }

  async editInteraction(applicationId: string, token: string, content: string | BetaMessage, deadlineMs = 20_000): Promise<void> {
    await this.request('PATCH', `/webhooks/${applicationId}/${encodeURIComponent(token)}/messages/@original`,
      { ...(typeof content === 'string' ? { content, embeds: [], components: [] } : content), allowed_mentions: allowedMentions }, { auth: false, deadlineMs });
  }
}
