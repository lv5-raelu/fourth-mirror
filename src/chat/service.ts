import { MAX_HISTORY_CHARACTERS, MAX_HISTORY_MESSAGES } from './store.ts';
import type { ChatStore } from './store.ts';
import { ChatError } from './types.ts';
import type { ChatMessage, ChatProvider, ChatSession } from './types.ts';

const MAX_PROMPT_CHARACTERS = 4_000;
const MAX_REPLY_CHARACTERS = 16_000;
const COOLDOWN_MS = 5_000;
const MAX_CONCURRENT_REQUESTS = 3;

export class ChatService {
  readonly #provider: ChatProvider;
  readonly #store: ChatStore;
  readonly #now: () => number;
  readonly #busyThreads = new Set<string>();
  readonly #busyUsers = new Set<string>();
  readonly #creatingUsers = new Set<string>();
  readonly #lastRequest = new Map<string, number>();
  readonly #lastCreated = new Map<string, number>();

  constructor(provider: ChatProvider, store: ChatStore, now: () => number = Date.now) {
    this.#provider = provider;
    this.#store = store;
    this.#now = now;
  }

  getSession(threadId: string): ChatSession | undefined {
    return this.#store.get(threadId);
  }

  async create(ownerId: string, createThread: () => Promise<string>): Promise<string> {
    this.#pruneCooldowns();
    if (this.#creatingUsers.has(ownerId) || this.#now() - (this.#lastCreated.get(ownerId) ?? -Infinity) < 30_000) {
      throw new ChatError('Please wait 30 seconds before starting another chat. You can keep talking in your existing thread.');
    }
    this.#creatingUsers.add(ownerId);
    this.#lastCreated.set(ownerId, this.#now());
    try {
      const threadId = await createThread();
      await this.#store.put({ threadId, ownerId, history: [], updatedAt: this.#now() });
      return threadId;
    } finally {
      this.#creatingUsers.delete(ownerId);
    }
  }

  async reset(threadId: string, ownerId: string): Promise<void> {
    const session = this.#ownedSession(threadId, ownerId);
    if (this.#busyThreads.has(threadId)) throw new ChatError('Wait for the current reply to finish before resetting.');
    this.#busyThreads.add(threadId);
    try {
      await this.#store.put({ ...session, history: [], updatedAt: this.#now() });
    } finally {
      this.#busyThreads.delete(threadId);
    }
  }

  async reply(threadId: string, ownerId: string, prompt: string, deliver: (text: string) => Promise<void>): Promise<void> {
    const session = this.#ownedSession(threadId, ownerId);
    const content = prompt.trim();
    if (!content) throw new ChatError('Send a text message to chat.');
    if (content.length > MAX_PROMPT_CHARACTERS) throw new ChatError('Please keep each message under 4,000 characters.');
    if (this.#busyThreads.has(threadId) || this.#busyUsers.has(ownerId)) {
      throw new ChatError('I’m still working on your previous message. Please wait for that reply.');
    }
    if (this.#busyUsers.size >= MAX_CONCURRENT_REQUESTS) throw new ChatError('All chat slots are busy. Please try again shortly.');
    this.#pruneCooldowns();
    if (this.#now() - (this.#lastRequest.get(ownerId) ?? -Infinity) < COOLDOWN_MS) {
      throw new ChatError('Please wait a few seconds before sending another message.');
    }

    this.#busyThreads.add(threadId);
    this.#busyUsers.add(ownerId);
    this.#lastRequest.set(ownerId, this.#now());
    try {
      const history = trimHistory(session.history, content.length);
      const input: ChatMessage[] = [...history, { role: 'user', content }];
      const answer = (await this.#provider.reply(input)).trim();
      if (!answer) throw new ChatError('The AI returned an empty response. Please try again.');
      const text = truncateReply(answer);
      await deliver(text);
      await this.#store.put({
        ...session,
        history: trimHistory([...input, { role: 'assistant', content: text }]),
        updatedAt: this.#now(),
      });
    } finally {
      this.#busyThreads.delete(threadId);
      this.#busyUsers.delete(ownerId);
    }
  }

  #ownedSession(threadId: string, ownerId: string): ChatSession {
    const session = this.#store.get(threadId);
    if (!session) throw new ChatError('Start a conversation with /chat, then use this command inside that thread.');
    if (session.ownerId !== ownerId) throw new ChatError('Only the person who started this chat can use it. Start your own with /chat.');
    return session;
  }

  #pruneCooldowns(): void {
    for (const [userId, time] of this.#lastRequest) {
      if (this.#now() - time >= COOLDOWN_MS) this.#lastRequest.delete(userId);
    }
    for (const [userId, time] of this.#lastCreated) {
      if (this.#now() - time >= 30_000) this.#lastCreated.delete(userId);
    }
  }
}

function truncateReply(answer: string): string {
  if (answer.length <= MAX_REPLY_CHARACTERS) return answer;
  const suffix = '\n\n*Reply shortened. Ask me to continue if needed.*';
  let end = MAX_REPLY_CHARACTERS - suffix.length;
  const lastCodeUnit = answer.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
  return answer.slice(0, end) + suffix;
}

function trimHistory(messages: readonly ChatMessage[], reservedCharacters = 0): ChatMessage[] {
  const history = [...messages];
  let characters = history.reduce((total, message) => total + message.content.length, reservedCharacters);
  // Remove complete exchanges so the next request always starts with a user message.
  while (history.length > MAX_HISTORY_MESSAGES || characters > MAX_HISTORY_CHARACTERS) {
    const removed = history.splice(0, 2);
    characters -= removed.reduce((total, message) => total + message.content.length, 0);
  }
  return history;
}
