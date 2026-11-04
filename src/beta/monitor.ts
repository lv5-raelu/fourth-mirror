import { BetaClient, compareRevisions } from './source.ts';
import type { BetaAlertState, BetaRevision, BetaStateStore } from './types.ts';

export const BETA_POLL_MS = 10 * 60_000;

export class BetaMonitor {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly client: BetaClient;
  private readonly store: BetaStateStore;
  private readonly guildId: string;
  private readonly now: () => number;
  constructor(client: BetaClient, store: BetaStateStore, guildId: string, now: () => number = Date.now) {
    this.client = client; this.store = store; this.guildId = guildId; this.now = now;
  }

  async status(): Promise<BetaAlertState> {
    const value = await this.store.load();
    return value?.guildId === this.guildId ? structuredClone(value) : { guildId: this.guildId, channelId: null, checkpoint: null, nextCheckAt: 0,
      lastCheckedAt: null, lastAnnouncedAt: null, lastError: null, deliveryPending: false };
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(task);
    this.queue = operation.catch(() => {});
    return operation;
  }

  configure(channelId: string | null): Promise<BetaAlertState> {
    return this.serial(async () => {
      const previous = await this.status();
      if (!channelId) {
        const state = { ...previous, channelId: null, deliveryPending: false, lastError: null };
        await this.store.save(state);
        return state;
      }
      // A fresh successful read establishes the baseline; enabling never announces old revisions.
      const feed = await this.client.feed(true);
      const state = { ...previous, channelId, checkpoint: { ...feed.revisions[0]!, entities: [] }, nextCheckAt: this.now() + BETA_POLL_MS,
        lastCheckedAt: feed.checkedAt, lastError: null, deliveryPending: false };
      await this.store.save(state);
      return state;
    });
  }

  check(send: (channelId: string, revisions: BetaRevision[], checkedAt: number, nonce: string) => Promise<void>): Promise<void> {
    return this.serial(async () => {
      const state = await this.status();
      if (!state.channelId || this.now() < state.nextCheckAt) return;
      state.nextCheckAt = this.now() + BETA_POLL_MS;
      if (state.deliveryPending) {
        // A predecessor may have posted before crashing. Do not repeat an ambiguous external send.
        state.deliveryPending = false;
        state.lastError = 'A previous announcement could not be confirmed. It will not be reposted automatically; use /beta latest.';
      }
      await this.store.save(state);
      let revisions: BetaRevision[];
      try {
        const feed = await this.client.feed(true);
        state.lastCheckedAt = feed.checkedAt;
        if (state.lastError?.startsWith('Gachabase could not be checked.')) state.lastError = null;
        revisions = feed.revisions.filter(revision => state.checkpoint && compareRevisions(revision, state.checkpoint) > 0);
        if (!revisions.length) { await this.store.save(state); return; }
      } catch {
        state.lastError = 'Gachabase could not be checked. The last good revision is retained; checking will resume automatically.';
        await this.store.save(state);
        return;
      }
      // Persist the watermark and delivery reservation before posting. A restart cannot flood duplicates.
      state.checkpoint = { ...revisions[0]!, entities: [] };
      state.deliveryPending = true;
      state.lastError = null;
      await this.store.save(state);
      try {
        await send(state.channelId, revisions, state.lastCheckedAt!, `beta${revisions[0]!.version.replaceAll('.', '')}${revisions[0]!.revision}`.slice(0, 25));
        state.lastAnnouncedAt = this.now();
      } catch {
        state.lastError = 'An announcement could not be delivered. Check the selected channel and bot permissions; use /beta latest for the update.';
      }
      state.deliveryPending = false;
      await this.store.save(state);
    });
  }
}
