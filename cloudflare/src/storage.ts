import type { ChatSession, ChatSessionStore } from '../../src/chat/types.ts';
import { MAX_SESSIONS } from '../../src/chat/limits.ts';
import { parseHistory } from '../../src/chat/history.ts';

export interface JournalEntry {
  id: string;
  kind: 'message' | 'mention' | 'interaction';
  channelId: string;
  token?: string;
  command?: string;
  createdThreadId?: string;
  createdAt: number;
}

export class BotStorage implements ChatSessionStore {
  readonly sql: SqlStorage;
  private sessions = new Map<string, ChatSession>();

  readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (thread_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at REAL NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL, updated_at REAL NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS journal_updated ON journal(updated_at)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS journal_status ON journal(status)');
    const version = this.getState<number>('schema') ?? 1;
    if (version !== 1) throw new Error('Unsupported bot database version.');
    this.setState('schema', 1);
    const saved = [...this.sql.exec<{ data: string }>('SELECT data FROM sessions')].map(row => JSON.parse(row.data) as unknown);
    const history = parseHistory({ version: 1, sessions: saved });
    this.sessions = new Map(history.sessions.map(session => [session.threadId, session]));
    // Only this constructor's instance can own active work. Never retry its predecessor's paid calls.
    this.sql.exec("UPDATE journal SET status = 'interrupted' WHERE status = 'pending'");
  }

  getState<T>(key: string): T | undefined {
    const row = [...this.sql.exec<{ value: string }>('SELECT value FROM state WHERE key = ?', key)][0];
    return row ? JSON.parse(row.value) as T : undefined;
  }

  setState(key: string, value: unknown): void {
    this.sql.exec('INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  }

  get(threadId: string): ChatSession | undefined { return this.sessions.get(threadId); }
  sessionCount(): number { return this.sessions.size; }

  async put(session: ChatSession): Promise<void> {
    const next = new Map(this.sessions);
    next.set(session.threadId, session);
    if (next.size > MAX_SESSIONS) {
      const oldest = [...next.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0]!;
      next.delete(oldest.threadId);
    }
    this.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at',
        session.threadId, JSON.stringify(session), session.updatedAt);
      for (const id of this.sessions.keys()) if (!next.has(id)) this.sql.exec('DELETE FROM sessions WHERE thread_id = ?', id);
    });
    this.sessions = next;
  }

  exportHistory(): { version: 1; sessions: ChatSession[] } {
    return parseHistory({ version: 1, sessions: [...this.sessions.values()] });
  }

  importHistory(data: unknown): number {
    const history = parseHistory(data);
    if (this.sessions.size) throw new Error('Import requires an empty destination. Export and keep the existing history first.');
    this.storage.transactionSync(() => {
      for (const session of history.sessions) this.sql.exec('INSERT INTO sessions VALUES (?, ?, ?)', session.threadId, JSON.stringify(session), session.updatedAt);
    });
    this.sessions = new Map(history.sessions.map(session => [session.threadId, session]));
    return history.sessions.length;
  }

  claim(entry: JournalEntry): boolean {
    return this.sql.exec('INSERT OR IGNORE INTO journal VALUES (?, ?, ?, ?)', entry.id, 'pending', JSON.stringify(entry), Date.now()).rowsWritten > 0;
  }

  updateEntry(entry: JournalEntry): void {
    this.sql.exec('UPDATE journal SET data = ?, updated_at = ? WHERE id = ?', JSON.stringify(entry), Date.now(), entry.id);
  }

  interrupt(id: string): void {
    this.sql.exec("UPDATE journal SET status = 'interrupted' WHERE id = ? AND status = 'pending'", id);
  }

  finish(id: string, status: 'complete' | 'failed' | 'recovered'): void {
    // Interaction tokens are short-lived credentials. Remove them as soon as work ends.
    const row = [...this.sql.exec<{ data: string; status: string }>('SELECT data, status FROM journal WHERE id = ?', id)][0];
    if (!row || !['pending', 'interrupted'].includes(row.status)) return;
    const entry = JSON.parse(row.data) as JournalEntry;
    delete entry.token;
    this.sql.exec('UPDATE journal SET status = ?, data = ?, updated_at = ? WHERE id = ?', status, JSON.stringify(entry), Date.now(), id);
  }

  interrupted(): JournalEntry[] {
    return [...this.sql.exec<{ data: string }>("SELECT data FROM journal WHERE status = 'interrupted' ORDER BY updated_at LIMIT 5")].map(row => JSON.parse(row.data) as JournalEntry);
  }

  prune(): void {
    this.sql.exec("DELETE FROM journal WHERE status NOT IN ('pending', 'interrupted') AND (updated_at < ? OR id IN (SELECT id FROM journal WHERE status NOT IN ('pending', 'interrupted') ORDER BY updated_at DESC LIMIT -1 OFFSET 5000))", Date.now() - 7 * 86400_000);
  }

  counts(): Record<string, number> {
    return Object.fromEntries([...this.sql.exec<{ status: string; count: number }>("SELECT status, COUNT(*) AS count FROM journal WHERE status IN ('pending', 'interrupted') GROUP BY status")].map(row => [row.status, row.count]));
  }
}
