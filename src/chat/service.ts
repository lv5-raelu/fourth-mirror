import { MAX_HISTORY_CHARACTERS, MAX_HISTORY_MESSAGES } from './limits.ts';
import { ChatError } from './types.ts';
import { CONTEXT_TIMEOUT_MS } from './context.ts';
import type { ChatContext, ChatMessage, ChatMode, ChatProvider, ChatSession, ChatSessionStore, SourceContext } from './types.ts';

const MAX_PROMPT_CHARACTERS = 4_000;
const MAX_REPLY_CHARACTERS = 16_000;
const COOLDOWN_MS = 5_000;
const MAX_CONCURRENT_REQUESTS = 3;
const MAX_GROUP_TURNS = 4;
const MAX_GROUP_PENDING = 12;

export interface ChatReplyOptions {
  readonly speakerName?: string;
  readonly onStart?: () => void;
  readonly shouldRespond?: () => Promise<boolean>;
}

export interface SingleAnswerOptions {
  readonly onStart?: () => void;
  readonly context?: () => Promise<ChatContext>;
  readonly source?: () => Promise<SourceContext>;
}

export class ChatService {
  readonly #provider: ChatProvider;
  readonly #store: ChatSessionStore;
  readonly #now: () => number;
  readonly #busyThreads = new Set<string>();
  readonly #busyUsers = new Set<string>();
  readonly #creatingUsers = new Set<string>();
  readonly #lastRequest = new Map<string, number>();
  readonly #lastCreated = new Map<string, number>();
  readonly #groupTails = new Map<string, Promise<void>>();
  readonly #groupCounts = new Map<string, number>();
  readonly #pendingUsers = new Set<string>();
  readonly #slotWaiters: { userId: string; resolve: () => void; reject: (error: Error) => void }[] = [];
  #queueGeneration = 0;
  #accepting = true;

  constructor(provider: ChatProvider, store: ChatSessionStore, now: () => number = Date.now) {
    this.#provider = provider;
    this.#store = store;
    this.#now = now;
  }

  getSession(threadId: string): ChatSession | undefined {
    return this.#store.get(threadId);
  }

  async create(ownerId: string, createThread: () => Promise<string>, mode: ChatMode = 'personal'): Promise<string> {
    this.#pruneCooldowns();
    if (this.#creatingUsers.has(ownerId) || this.#now() - (this.#lastCreated.get(ownerId) ?? -Infinity) < 30_000) {
      throw new ChatError('Please wait 30 seconds before starting another chat. You can keep talking in your existing thread.');
    }
    this.#creatingUsers.add(ownerId);
    this.#lastCreated.set(ownerId, this.#now());
    try {
      const threadId = await createThread();
      await this.#store.put({ threadId, ownerId, history: [], updatedAt: this.#now(), ...(mode === 'group' ? { mode } : {}) });
      return threadId;
    } finally {
      this.#creatingUsers.delete(ownerId);
    }
  }

  async reset(threadId: string, ownerId: string): Promise<void> {
    const session = this.#ownedSession(threadId, ownerId);
    if (this.#busyThreads.has(threadId) || this.#groupCounts.has(threadId)) throw new ChatError('Wait for the current reply and queued messages to finish before resetting.');
    this.#busyThreads.add(threadId);
    try {
      await this.#store.put({ ...session, history: [], updatedAt: this.#now() });
    } finally {
      this.#busyThreads.delete(threadId);
    }
  }

  async reply(threadId: string, userId: string, prompt: string, deliver: (text: string) => Promise<void>, options: ChatReplyOptions = {}): Promise<void> {
    if (!this.#accepting) throw restarting();
    const session = this.#replySession(threadId, userId);
    const group = session.mode === 'group';
    const content = this.#validateRequest(userId, prompt);
    if (!group && this.#busyThreads.has(threadId)) {
      throw new ChatError('I’m still working on your previous message. Please wait for that reply.');
    }
    if (!group && this.#busyUsers.size >= MAX_CONCURRENT_REQUESTS) throw new ChatError('All chat slots are busy. Please try again shortly.');
    if (group && ((this.#groupCounts.get(threadId) ?? 0) >= MAX_GROUP_TURNS || this.#pendingUsers.size >= MAX_GROUP_PENDING)) {
      throw new ChatError('The group chat queue is full. Please wait for some replies before asking again.');
    }
    if (!group) this.#lastRequest.set(userId, this.#now());
    if (!group) return this.#respond(threadId, userId, content, deliver, options);

    const generation = this.#queueGeneration;
    this.#pendingUsers.add(userId);
    this.#groupCounts.set(threadId, (this.#groupCounts.get(threadId) ?? 0) + 1);
    const previous = this.#groupTails.get(threadId) ?? Promise.resolve();
    const operation = previous.then(() => this.#respond(threadId, userId, content, deliver, options, generation));
    const tail = operation.then(() => {}, () => {});
    this.#groupTails.set(threadId, tail);
    try {
      await operation;
    } finally {
      this.#pendingUsers.delete(userId);
      const count = (this.#groupCounts.get(threadId) ?? 1) - 1;
      if (count) this.#groupCounts.set(threadId, count);
      else this.#groupCounts.delete(threadId);
      if (this.#groupTails.get(threadId) === tail) this.#groupTails.delete(threadId);
    }
  }

  // A mention outside a chat is one independent turn, with no session or history writes.
  async answer(userId: string, prompt: string, deliver: (text: string) => Promise<void>, options: SingleAnswerOptions = {}): Promise<void> {
    const content = this.#validateRequest(userId, prompt);
    if (this.#busyUsers.size >= MAX_CONCURRENT_REQUESTS) throw new ChatError('All chat slots are busy. Please try again shortly.');
    this.#lastRequest.set(userId, this.#now());
    await this.#takeSlot(userId, false);
    try {
      if (!this.#accepting) throw restarting();
      options.onStart?.();
      // History access is optional and runs only after admission. A denied read still allows an answer.
      // A dedicated source query must fail if its source cannot load; never silently answer from memory.
      const source = await options.source?.();
      const context = source ? { questionAuthor: 'User', recentMessages: [], source } : await this.#loadContext(options.context);
      if (!this.#accepting) throw restarting();
      await deliver(await this.#generateReply([{ role: 'user', content }], context));
    } finally {
      this.#releaseSlot(userId);
    }
  }

  #validateRequest(userId: string, prompt: string): string {
    if (!this.#accepting) throw restarting();
    const content = prompt.trim();
    if (!content) throw new ChatError('Send a text message to chat.');
    if (content.length > MAX_PROMPT_CHARACTERS) throw new ChatError('Please keep each message under 4,000 characters.');
    if (this.#busyUsers.has(userId) || this.#pendingUsers.has(userId)) {
      throw new ChatError('I’m still working on your previous message. Please wait for that reply.');
    }
    this.#pruneCooldowns();
    if (this.#now() - (this.#lastRequest.get(userId) ?? -Infinity) < COOLDOWN_MS) {
      throw new ChatError('Please wait a few seconds before sending another message.');
    }
    return content;
  }

  async #generateReply(input: readonly ChatMessage[], context?: ChatContext): Promise<string> {
    const answer = (await this.#provider.reply(input, context)).trim();
    if (!answer) throw new ChatError('The AI returned an empty response. Please try again.');
    return truncateReply(answer);
  }

  async #loadContext(load: SingleAnswerOptions['context']): Promise<ChatContext | undefined> {
    if (!load) return undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([load(), new Promise<undefined>(resolve => {
        timeout = setTimeout(() => resolve(undefined), CONTEXT_TIMEOUT_MS + 250);
      })]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Accepted paid turns finish normally. Waiting turns are cancelled before restart, without another paid call.
  cancelQueuedReplies(): void {
    this.#accepting = false;
    this.#queueGeneration++;
    for (const waiter of this.#slotWaiters.splice(0)) waiter.reject(restarting());
  }

  resumeReplies(): void { this.#accepting = true; }

  async #respond(threadId: string, userId: string, content: string, deliver: (text: string) => Promise<void>, options: ChatReplyOptions, generation?: number): Promise<void> {
    if (generation !== undefined && generation !== this.#queueGeneration) throw restarting();
    this.#busyThreads.add(threadId);
    let acquired = false;
    try {
      // Reserve FIFO position before an older Discord reply reference needs fetching.
      if (options.shouldRespond && !await options.shouldRespond()) return;
      if (!this.#accepting || (generation !== undefined && generation !== this.#queueGeneration)) throw restarting();
      await this.#takeSlot(userId, generation !== undefined);
      acquired = true;
      if (!this.#accepting || (generation !== undefined && generation !== this.#queueGeneration)) throw restarting();
      // Read after waiting: a preceding group turn may have saved new context.
      const session = this.#replySession(threadId, userId);
      if (session.mode === 'group') this.#lastRequest.set(userId, this.#now());
      options.onStart?.();
      const history = trimHistory(session.history, content.length);
      const name = options.speakerName?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80) || 'User';
      const input: ChatMessage[] = [...history, { role: 'user', content,
        ...(session.mode === 'group' ? { speaker: { id: userId, name } } : {}),
      }];
      const text = await this.#generateReply(input);
      await deliver(text);
      await this.#store.put({
        ...session,
        history: trimHistory([...input, { role: 'assistant', content: text }]),
        updatedAt: this.#now(),
      });
    } finally {
      this.#busyThreads.delete(threadId);
      if (acquired) this.#releaseSlot(userId);
    }
  }

  async #takeSlot(userId: string, wait: boolean): Promise<void> {
    if (this.#busyUsers.size < MAX_CONCURRENT_REQUESTS) { this.#busyUsers.add(userId); return; }
    if (!wait) throw new ChatError('All chat slots are busy. Please try again shortly.');
    await new Promise<void>((resolve, reject) => this.#slotWaiters.push({ userId, resolve, reject }));
  }

  #releaseSlot(userId: string): void {
    this.#busyUsers.delete(userId);
    const next = this.#slotWaiters.shift();
    if (next) { this.#busyUsers.add(next.userId); next.resolve(); }
  }

  #replySession(threadId: string, userId: string): ChatSession {
    const session = this.#store.get(threadId);
    if (session?.mode === 'group') return session;
    return this.#ownedSession(threadId, userId);
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

function restarting(): ChatError {
  return new ChatError('I’m restarting before starting your queued question. Please resend it once I’m back.');
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
