import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ChatSession } from './types.ts';

export const MAX_SESSIONS = 100;
export const MAX_HISTORY_MESSAGES = 20;
export const MAX_HISTORY_CHARACTERS = 24_000;

export class ChatStore {
  readonly #file: string;
  #sessions = new Map<string, ChatSession>();
  #writes: Promise<void> = Promise.resolve();

  private constructor(file: string) {
    this.#file = resolve(file);
  }

  static async open(file: string): Promise<ChatStore> {
    const store = new ChatStore(file);
    let data: unknown;
    try {
      data = JSON.parse(await readFile(store.#file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw new Error('Could not read AI_HISTORY_FILE. Fix or move the history file before restarting.');
    }

    if (!isStoreData(data)) {
      throw new Error('AI_HISTORY_FILE contains invalid chat history. Fix or move the file before restarting.');
    }
    for (const session of data.sessions) {
      if (store.#sessions.has(session.threadId)) throw new Error('AI_HISTORY_FILE contains duplicate threads.');
      store.#sessions.set(session.threadId, session);
    }
    return store;
  }

  get(threadId: string): ChatSession | undefined {
    return this.#sessions.get(threadId);
  }

  async put(session: ChatSession): Promise<void> {
    const write = this.#writes.then(async () => {
      const next = new Map(this.#sessions);
      next.set(session.threadId, session);
      if (next.size > MAX_SESSIONS) {
        const oldest = [...next.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (oldest) next.delete(oldest.threadId);
      }

      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
      const temporaryFile = `${this.#file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryFile, JSON.stringify({ version: 1, sessions: [...next.values()] }), { mode: 0o600 });
        await rename(temporaryFile, this.#file);
        this.#sessions = next;
      } finally {
        await rm(temporaryFile, { force: true });
      }
    });
    // One failed write must not prevent later attempts from saving other sessions.
    this.#writes = write.catch(() => {});
    await write;
  }
}

function isStoreData(data: unknown): data is { version: 1; sessions: ChatSession[] } {
  if (typeof data !== 'object' || data === null || !('version' in data) || data.version !== 1 || !('sessions' in data)) return false;
  if (!Array.isArray(data.sessions) || data.sessions.length > MAX_SESSIONS) return false;
  return data.sessions.every((session: unknown) => {
    if (typeof session !== 'object' || session === null) return false;
    if (!('threadId' in session) || typeof session.threadId !== 'string' || !/^\d{17,20}$/.test(session.threadId)) return false;
    if (!('ownerId' in session) || typeof session.ownerId !== 'string' || !/^\d{17,20}$/.test(session.ownerId)) return false;
    if (!('updatedAt' in session) || typeof session.updatedAt !== 'number' || !Number.isFinite(session.updatedAt)) return false;
    if (!('history' in session) || !Array.isArray(session.history) || session.history.length > MAX_HISTORY_MESSAGES || session.history.length % 2 !== 0) return false;
    let characters = 0;
    const valid = session.history.every((message: unknown, index: number) => {
      if (typeof message !== 'object' || message === null) return false;
      if (!('role' in message) || message.role !== (index % 2 === 0 ? 'user' : 'assistant')) return false;
      if (!('content' in message) || typeof message.content !== 'string' || !message.content.trim()) return false;
      characters += message.content.length;
      return true;
    });
    return valid && characters <= MAX_HISTORY_CHARACTERS;
  });
}
