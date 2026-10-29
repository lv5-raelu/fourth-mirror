export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

// Providers implement this interface; Discord and stored history use no SDK types.
export interface ChatProvider {
  reply(messages: readonly ChatMessage[]): Promise<string>;
}

export interface ChatSession {
  readonly threadId: string;
  readonly ownerId: string;
  readonly history: readonly ChatMessage[];
  readonly updatedAt: number;
}

export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}
