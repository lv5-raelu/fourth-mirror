import { ChannelType, DiscordAPIError, Events, Routes } from 'discord.js';
import type { Client, Message } from 'discord.js';
import { splitDiscordMessage } from '../chat/messages.ts';
import { ChatError } from '../chat/types.ts';
import type { BotContext } from '../types.ts';
import type { PendingWork } from '../lifecycle.ts';
import { hasBotMention, withoutBotMention } from '../chat/group.ts';
import { loadChannelContext } from '../chat/context.ts';
import type { DiscordContextMessage } from '../chat/context.ts';

export async function handleChatMessage(message: Message, context: BotContext): Promise<void> {
  const { chat, config, logger } = context;
  if (!chat || message.guildId !== config.guildId || message.author.bot || message.webhookId || message.system) return;
  if (message.channel.type === ChannelType.DM || message.channel.type === ChannelType.GroupDM) return;
  const session = chat.getSession(message.channelId);
  const standalone = !session;
  const group = session?.mode === 'group';
  if (session && message.channel.type !== ChannelType.PrivateThread && message.channel.type !== ChannelType.PublicThread) return;
  if (session && !group && (message.channel.type !== ChannelType.PrivateThread || session.ownerId !== message.author.id)) return;
  const botId = group || standalone ? message.client?.user?.id : undefined;
  if (standalone && (!botId || !message.mentions.users.has(botId) || !hasBotMention(message.content, botId))) return;
  let shouldRespond: (() => Promise<boolean>) | undefined;
  if (group) {
    if (!botId) return;
    let addressed = message.mentions.users.has(botId);
    if (!addressed && message.reference?.messageId && (message.reference.type ?? 0) === 0 && message.reference.channelId === message.channelId) {
      const cached = message.channel.messages?.cache.get(message.reference.messageId);
      if (cached) addressed = cached.author.id === botId && !cached.webhookId;
      else shouldRespond = async () => {
        try { const reference = await message.fetchReference(); return reference.author.id === botId && !reference.webhookId; }
        catch { return false; }
      };
    }
    if (!addressed && !shouldRespond) return;
  }
  const channel = message.channel;
  const send = async (content: string): Promise<void> => {
    const payload = { content, allowedMentions: { parse: [], repliedUser: false } };
    try {
      await channel.send({ ...payload,
        ...(group || standalone ? { reply: { messageReference: message.id, failIfNotExists: false } } : {}),
      });
    } catch (error) {
      // Discord requires Read Message History for linked replies, even if a normal send is allowed.
      if (!standalone || !(error instanceof DiscordAPIError) || error.status !== 403) throw error;
      await channel.send(payload);
    }
  };

  let typing: ReturnType<typeof setInterval> | undefined;
  try {
    if (message.attachments.size > 0 || message.stickers.size > 0) {
      await send('This chat supports text messages. Please send your question without attachments or stickers.');
      return;
    }
    const prompt = group || standalone ? withoutBotMention(message.content, botId!) : message.content;
    if (!prompt.trim()) {
      await send(standalone ? 'Add a text question after mentioning me.' : 'I couldn’t read that message. Send text; if this keeps happening, ask the bot owner to check Message Content Intent.');
      return;
    }
    // Typing is cosmetic; a failed indicator must not abort a conversation.
    const showTyping = (): void => { void channel.sendTyping().catch(() => {}); };
    const deliver = async (text: string): Promise<void> => {
      for (const chunk of splitDiscordMessage(text)) await send(chunk);
    };
    const onStart = (): void => { showTyping(); typing = setInterval(showTyping, 8_000); typing.unref(); };
    if (standalone) await chat.answer(message.author.id, prompt, deliver, {
      onStart,
      context: () => loadChannelContext(message.member?.displayName || message.author.displayName, message.channelId, message.id, {
        // Raw REST reads avoid populating Discord.js's message cache with fetched context.
        recent: async (limit, signal) => await message.client.rest.get(Routes.channelMessages(message.channelId),
          { query: new URLSearchParams({ before: message.id, limit: String(limit) }), signal }) as DiscordContextMessage[],
        message: async (id, signal) => await message.client.rest.get(Routes.channelMessage(message.channelId, id), { signal }) as DiscordContextMessage,
      }),
    });
    else await chat.reply(message.channelId, message.author.id, prompt, deliver, {
      speakerName: message.member?.displayName || message.author.displayName,
      ...(shouldRespond ? { shouldRespond } : {}),
      onStart,
    });
  } catch (error) {
    // Provider errors have already been replaced with safe messages by the adapter.
    logger.warn('Chat message could not be completed.', { threadId: message.channelId, expected: error instanceof ChatError });
    try {
      await send(error instanceof ChatError ? error.message : 'Could not finish that reply. Please try again later.');
    } catch {
      logger.warn('Could not send a chat error response.', { threadId: message.channelId });
    }
  } finally {
    if (typing) clearInterval(typing);
  }
}

export function registerMessageCreate(client: Client, context: BotContext, work: PendingWork): void {
  client.on(Events.MessageCreate, (message) => {
    void work.run(() => handleChatMessage(message, context)).catch(() => {
      context.logger.error('Unexpected failure handling a chat message.');
    });
  });
}
