import { commandDefinitions } from './definitions.ts';
import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, ThreadAutoArchiveDuration } from 'discord.js';
import type { ThreadChannel } from 'discord.js';
import { ChatError } from '../chat/types.ts';
import { missingChatThreadPermissions } from '../chat/permissions.ts';
import type { Command } from '../types.ts';

export const chat: Command = {
  data: new SlashCommandBuilder()
    .setName(commandDefinitions.chat.name)
    .setDescription(commandDefinitions.chat.description)
    .addStringOption(option => option.setName(commandDefinitions.chat.mode.name)
      .setDescription(commandDefinitions.chat.mode.description)
      .addChoices(...commandDefinitions.chat.mode.choices)),
  async execute(interaction, { chat, logger }) {
    if (!chat) {
      await interaction.reply({ content: 'AI chat is not configured yet. Please contact the bot owner.', flags: MessageFlags.Ephemeral });
      return;
    }
    const mode = interaction.options.getString('mode') === 'group' ? 'group' : 'personal';
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = await interaction.client.channels.fetch(interaction.channelId);
    if (channel?.type !== ChannelType.GuildText) {
      await interaction.editReply('Run /chat in a regular server text channel to start a conversation.');
      return;
    }

    const botPermissions = channel.permissionsFor(interaction.client.user);
    const missingPermissions = missingChatThreadPermissions(mode, bit => botPermissions?.has(bit) ?? false);
    if (missingPermissions.length) {
      await interaction.editReply(`Missing bot permissions here: ${missingPermissions.join(', ')}. Check this channel’s permission overrides.`);
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
          name: `${mode === 'group' ? 'Group chat' : 'Chat'} · ${interaction.user.displayName}`.slice(0, 100),
          type: mode === 'group' ? ChannelType.PublicThread : ChannelType.PrivateThread,
          ...(mode === 'personal' ? { invitable: false } : {}),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
          reason: 'User requested an AI conversation.',
        });
        createdThread = thread;
        await thread.members.add(interaction.user.id);
        await thread.send({
          content: mode === 'group'
            ? 'Your public group chat is ready. Anyone who can view the parent channel can see and join this thread. Mention me or reply to one of my messages to ask a question. Addressed questions share one history and replies are queued in order. Only the person who started this chat can use /reset.\n\nAddressed messages are sent to the AI provider. Attachments are not supported.'
            : 'Your chat is ready. Send a text message and I’ll reply here. Use /reset to start with fresh context.\n\nMessages are sent to the bot’s AI provider. Server moderators can access private threads. Attachments are not supported.',
          allowedMentions: { parse: [] },
        });
        return thread.id;
      }, mode);
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
