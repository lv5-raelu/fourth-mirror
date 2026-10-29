import { ChannelType, Events } from 'discord.js';
import type { Client, Message } from 'discord.js';
import { splitDiscordMessage } from '../chat/messages.ts';
import { ChatError } from '../chat/types.ts';
import type { BotContext } from '../types.ts';

export async function handleChatMessage(message: Message, context: BotContext): Promise<void> {
  const { chat, config, logger } = context;
  if (!chat || message.guildId !== config.guildId || message.author.bot || message.webhookId || message.system) return;
  if (message.channel.type !== ChannelType.PrivateThread) return;
  const session = chat.getSession(message.channelId);
  // Only the creator's messages in registered threads are ever sent to the provider.
  if (!session || session.ownerId !== message.author.id) return;
  const channel = message.channel;
  const send = async (content: string): Promise<void> => {
    await channel.send({ content, allowedMentions: { parse: [], repliedUser: false } });
  };

  let typing: ReturnType<typeof setInterval> | undefined;
  try {
    if (message.attachments.size > 0 || message.stickers.size > 0) {
      await send('This chat supports text messages. Please send your question without attachments or stickers.');
      return;
    }
    if (!message.content.trim()) {
      await send('I couldn’t read that message. Send text; if this keeps happening, ask the bot owner to check Message Content Intent.');
      return;
    }
    // Typing is cosmetic; a failed indicator must not abort a conversation.
    const showTyping = (): void => { void channel.sendTyping().catch(() => {}); };
    showTyping();
    typing = setInterval(showTyping, 8_000);
    typing.unref();

    await chat.reply(message.channelId, message.author.id, message.content, async (text) => {
      for (const chunk of splitDiscordMessage(text)) await send(chunk);
    });
  } catch (error) {
    // Provider errors have already been replaced with safe messages by the adapter.
    logger.warn('Chat message could not be completed.', { threadId: message.channelId, expected: error instanceof ChatError });
    try {
      await send(error instanceof ChatError ? error.message : 'Could not finish that reply or save the conversation. Please try again later.');
    } catch {
      logger.warn('Could not send a chat error response.', { threadId: message.channelId });
    }
  } finally {
    if (typing) clearInterval(typing);
  }
}

export function registerMessageCreate(client: Client, context: BotContext): void {
  client.on(Events.MessageCreate, (message) => {
    void handleChatMessage(message, context).catch(() => {
      context.logger.error('Unexpected failure handling a chat message.');
    });
  });
}
