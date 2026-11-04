import type { ChatSession } from './types.ts';
import { MAX_SESSIONS, MAX_HISTORY_MESSAGES, MAX_HISTORY_CHARACTERS } from './limits.ts';

export function isStoreData(data: unknown): data is { version: 1; sessions: ChatSession[] } {
  if (typeof data !== 'object' || data === null || !('version' in data) || data.version !== 1 || !('sessions' in data)) return false;
  if (!Array.isArray(data.sessions) || data.sessions.length > MAX_SESSIONS) return false;
  return data.sessions.every((session: unknown) => {
    if (typeof session !== 'object' || session === null) return false;
    if (!('threadId' in session) || typeof session.threadId !== 'string' || !/^\d{17,20}$/.test(session.threadId)) return false;
    if (!('ownerId' in session) || typeof session.ownerId !== 'string' || !/^\d{17,20}$/.test(session.ownerId)) return false;
    if (!('updatedAt' in session) || typeof session.updatedAt !== 'number' || !Number.isFinite(session.updatedAt)) return false;
    if ('mode' in session && session.mode !== 'personal' && session.mode !== 'group') return false;
    if (!('history' in session) || !Array.isArray(session.history) || session.history.length > MAX_HISTORY_MESSAGES || session.history.length % 2 !== 0) return false;
    let characters = 0;
    const valid = session.history.every((message: unknown, index: number) => {
      if (typeof message !== 'object' || message === null) return false;
      if (!('role' in message) || message.role !== (index % 2 === 0 ? 'user' : 'assistant')) return false;
      if (!('content' in message) || typeof message.content !== 'string' || !message.content.trim()) return false;
      if ('speaker' in message) {
        const speaker = message.speaker;
        if (!('mode' in session) || session.mode !== 'group' || message.role !== 'user' ||
          typeof speaker !== 'object' || speaker === null || !('id' in speaker) || typeof speaker.id !== 'string' ||
          !/^[1-9]\d{16,19}$/.test(speaker.id) || !('name' in speaker) || typeof speaker.name !== 'string' ||
          !speaker.name.trim() || speaker.name.length > 80 || /[\u0000-\u001f\u007f]/.test(speaker.name)) return false;
      }
      characters += message.content.length;
      return true;
    });
    return valid && characters <= MAX_HISTORY_CHARACTERS;
  });
}

export function parseHistory(data: unknown): { version: 1; sessions: ChatSession[] } {
  if (!isStoreData(data)) throw new Error('Invalid chat history.');
  const ids = new Set<string>();
  for (const session of data.sessions) {
    if (ids.has(session.threadId)) throw new Error('Duplicate chat threads.');
    ids.add(session.threadId);
  }
  return { version: 1, sessions: data.sessions.map(({ threadId, ownerId, updatedAt, history, mode }) => ({
    threadId, ownerId, updatedAt, ...(mode ? { mode } : {}),
    history: history.map(({ role, content, speaker }) => ({ role, content, ...(speaker ? { speaker: { id: speaker.id, name: speaker.name } } : {}) })),
  })) };
}
