import { BetaClient } from './source.ts';
import { BetaMonitor } from './monitor.ts';
import type { BetaFeature } from './feature.ts';
import type { BetaFeed, BetaRevision, BetaStateCollection } from './types.ts';

/** Share the source cache while keeping configuration, checkpoints, and queues per server. */
export class ServerBeta {
  private readonly features = new Map<string, BetaFeature>();
  readonly client: BetaClient;
  private readonly store: BetaStateCollection;
  private readonly now: () => number;
  constructor(client: BetaClient, store: BetaStateCollection, now: () => number = Date.now) {
    this.client = client; this.store = store; this.now = now;
  }

  forGuild(guildId: string): BetaFeature {
    if (!/^[1-9]\d{16,19}$/.test(guildId)) throw new Error('Invalid beta server ID.');
    let feature = this.features.get(guildId);
    if (!feature) {
      feature = { client: this.client, monitor: new BetaMonitor(this.client, this.store, guildId, this.now) };
      this.features.set(guildId, feature);
    }
    return feature;
  }

  async check(allowed: (guildId: string) => boolean,
    send: (guildId: string, channelId: string, revisions: BetaRevision[], checkedAt: number, nonce: string) => Promise<void>): Promise<void> {
    const states = (await this.store.list()).filter(state => state.channelId && allowed(state.guildId));
    // Share one fresh source result even if storage or delivery makes the monitors reach it at different times.
    let feed: Promise<BetaFeed> | undefined;
    const results = await Promise.allSettled(states.map(state => this.forGuild(state.guildId).monitor.check(
      (channelId, revisions, checkedAt, nonce) => send(state.guildId, channelId, revisions, checkedAt, nonce),
      () => feed ??= this.client.feed(true))));
    if (results.some(result => result.status === 'rejected')) throw new Error('A beta notification check could not finish.');
  }
}
