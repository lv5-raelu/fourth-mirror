export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly speaker?: { readonly id: string; readonly name: string };
  readonly media?: readonly ChatMedia[];
}

// Persist references only. Downloaded bytes and rendered frames live for one model turn.
export interface ChatMedia {
  readonly url: string;
  readonly name: string;
  readonly kind: 'image' | 'lottie' | 'preview' | 'gif-page';
  readonly previewUrl?: string;
}

export type ChatMode = 'personal' | 'group';

export interface ChatContextMessage {
  readonly id?: string;
  readonly author: string;
  readonly content: string;
  /** Set by the Discord context loader from the bot's actual author ID, never its display name. */
  readonly isOwnReply?: true;
  readonly replyTo?: string;
  readonly media?: readonly ChatMedia[];
}

export interface ChatContext {
  readonly questionAuthor: string;
  readonly questionReplyTo?: string;
  readonly recentMessages: readonly ChatContextMessage[];
  readonly referencedMessages?: readonly ChatContextMessage[];
  readonly source?: SourceContext;
}

export interface SourceContext {
  readonly title: string;
  readonly url: string;
  readonly content: string;
  readonly checkedAt: number;
}

// Providers implement this interface; Discord and stored history use no SDK types.
export interface ChatProvider {
  reply(messages: readonly ChatMessage[], context?: ChatContext): Promise<string>;
}

export interface ChatSession {
  readonly threadId: string;
  readonly ownerId: string;
  readonly history: readonly ChatMessage[];
  readonly updatedAt: number;
  readonly mode?: ChatMode;
}

export interface ChatSessionStore {
  get(threadId: string): ChatSession | undefined;
  put(session: ChatSession): Promise<void>;
}

export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}
