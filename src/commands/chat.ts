import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, ThreadAutoArchiveDuration } from 'discord.js';
import type { ThreadChannel } from 'discord.js';
import { ChatError } from '../chat/types.ts';
import type { Command } from '../types.ts';

export const chat: Command = {
  data: new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Start a private conversation with the AI.'),
  async execute(interaction, { chat, logger }) {
    if (!chat) {
      await interaction.reply({ content: 'AI chat is not configured yet. Please contact the bot owner.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = await interaction.client.channels.fetch(interaction.channelId);
    if (channel?.type !== ChannelType.GuildText) {
      await interaction.editReply('Run /chat in a regular server text channel to start a conversation.');
      return;
    }

    const requiredPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.CreatePrivateThreads,
      PermissionFlagsBits.SendMessagesInThreads,
    ];
    if (!channel.permissionsFor(interaction.client.user)?.has(requiredPermissions)) {
      await interaction.editReply('I need View Channel, Send Messages, Read Message History, Create Private Threads, and Send Messages in Threads permissions here.');
      return;
    }
    if (!channel.permissionsFor(interaction.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads])) {
      await interaction.editReply('You need View Channel and Send Messages in Threads permissions here to use AI chat.');
      return;
    }

    let createdThread: ThreadChannel | undefined;
    try {
      const threadId = await chat.create(interaction.user.id, async () => {
        const thread = await channel.threads.create({
          name: `Chat · ${interaction.user.displayName}`.slice(0, 100),
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
          reason: 'User requested an AI conversation.',
        });
        createdThread = thread;
        await thread.members.add(interaction.user.id);
        await thread.send({
          content: 'Your chat is ready. Send a text message and I’ll reply here. Use /reset to start with fresh context.\n\nMessages are sent to the bot’s AI provider. Server moderators can access private threads. Attachments are not supported.',
          allowedMentions: { parse: [] },
        });
        return thread.id;
      });
      await interaction.editReply(`Your conversation is ready: <#${threadId}>`);
    } catch (error) {
      // Archive partially created threads if invitation or saving failed.
      if (createdThread && !chat.getSession(createdThread.id)) {
        await createdThread.setArchived(true).catch(() => logger.warn('Could not archive an unfinished chat thread.'));
      }
      if (error instanceof ChatError) {
        await interaction.editReply(error.message);
        return;
      }
      throw error;
    }
  },
};
