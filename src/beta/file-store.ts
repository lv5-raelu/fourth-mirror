import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BetaAlertState, BetaStateStore } from './types.ts';

export class BetaFileStore implements BetaStateStore {
  private value: BetaAlertState | undefined;
  private readonly file: string;
  private constructor(file: string) { this.file = file; }
  static async open(file: string): Promise<BetaFileStore> {
    const store = new BetaFileStore(file);
    try {
      const value = JSON.parse(await readFile(file, 'utf8')) as BetaAlertState;
      if (!value || typeof value.guildId !== 'string' || (value.channelId !== null && !/^[1-9]\d{16,19}$/.test(value.channelId)) ||
        typeof value.nextCheckAt !== 'number' || typeof value.deliveryPending !== 'boolean') throw new Error('Invalid beta settings.');
      store.value = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read beta-alerts.json. Fix or move the file before restarting.');
    }
    return store;
  }
  async load(): Promise<BetaAlertState | undefined> { return this.value; }
  async save(value: BetaAlertState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, this.file);
      this.value = structuredClone(value);
    } finally { await rm(temporary, { force: true }); }
  }
}
