import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BetaAlertState, BetaStateCollection } from './types.ts';

export class BetaFileStore implements BetaStateCollection {
  private values = new Map<string, BetaAlertState>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private constructor(file: string) { this.file = file; }
  static async open(file: string): Promise<BetaFileStore> {
    const store = new BetaFileStore(file);
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      // Read the previous single-server format; the next write atomically upgrades it.
      const values: BetaAlertState[] = data?.version === 2 && Array.isArray(data.guilds) ? data.guilds : [data];
      for (const value of values) {
        if (!value || typeof value.guildId !== 'string' || !/^[1-9]\d{16,19}$/.test(value.guildId) ||
          (value.channelId !== null && (typeof value.channelId !== 'string' || !/^[1-9]\d{16,19}$/.test(value.channelId))) ||
          typeof value.nextCheckAt !== 'number' || typeof value.deliveryPending !== 'boolean' || store.values.has(value.guildId)) throw new Error('Invalid beta settings.');
        store.values.set(value.guildId, value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read beta-alerts.json. Fix or move the file before restarting.');
    }
    return store;
  }
  async load(guildId: string): Promise<BetaAlertState | undefined> { return structuredClone(this.values.get(guildId)); }
  async list(): Promise<BetaAlertState[]> { return structuredClone([...this.values.values()]); }
  save(value: BetaAlertState): Promise<void> {
    const snapshot = structuredClone(value);
    const operation = this.queue.then(async () => {
      const values = new Map(this.values);
      values.set(snapshot.guildId, snapshot);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify({ version: 2, guilds: [...values.values()] }), { mode: 0o600 });
        await rename(temporary, this.file);
        this.values = values;
      } finally { await rm(temporary, { force: true }); }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
