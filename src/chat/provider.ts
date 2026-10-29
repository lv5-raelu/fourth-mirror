import OpenAI from 'openai';
import type { AiConfig } from '../config.ts';
import { ChatError } from './types.ts';
import type { ChatMessage, ChatProvider } from './types.ts';

export class OpenAICompatibleProvider implements ChatProvider {
  readonly #client: OpenAI;
  readonly #config: AiConfig;

  constructor(config: AiConfig) {
    this.#config = config;
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: 45_000,
      // Avoid duplicate paid requests when a provider fails after accepting a turn.
      maxRetries: 0,
    });
  }

  async reply(messages: readonly ChatMessage[]): Promise<string> {
    try {
      const result = await this.#client.chat.completions.create({
        model: this.#config.model,
        messages: [{ role: 'system', content: this.#config.systemPrompt }, ...messages],
        [this.#config.tokenLimitParam]: this.#config.maxOutputTokens,
      });
      const choice = result.choices[0];
      const text = choice?.message.content?.trim() || choice?.message.refusal?.trim();
      if (!text) {
        throw new ChatError('The AI returned no text. Try again, or ask the bot owner to check the model settings.');
      }
      return choice?.finish_reason === 'length'
        ? `${text}\n\n*Response reached its length limit. Ask me to continue if needed.*`
        : text;
    } catch (error) {
      if (error instanceof ChatError) throw error;
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new ChatError('The AI took too long to respond. Please try again.');
      }
      if (error instanceof OpenAI.APIError) {
        if (error.status === 429) {
          throw new ChatError('The AI provider is busy or has reached its usage limit. Please try again later.');
        }
        if ([400, 401, 403, 404].includes(error.status ?? 0)) {
          throw new ChatError('AI chat is unavailable. The bot owner needs to check the provider, API key, and model settings.');
        }
      }
      // Do not forward or log provider response bodies: they can contain prompts or credentials.
      throw new ChatError('Could not reach the AI provider. Please try again later.');
    }
  }
}
