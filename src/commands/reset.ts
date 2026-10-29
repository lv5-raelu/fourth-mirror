import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { ChatError } from '../chat/types.ts';
import type { Command } from '../types.ts';

export const reset: Command = {
  data: new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Clear the AI’s conversation context in your chat thread.'),
  async execute(interaction, { chat }) {
    if (!chat) {
      await interaction.reply({ content: 'AI chat is not configured yet. Please contact the bot owner.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await chat.reset(interaction.channelId, interaction.user.id);
      await interaction.editReply('Conversation context cleared. Your next message starts fresh. Earlier Discord messages remain visible.');
    } catch (error) {
      if (error instanceof ChatError) {
        await interaction.editReply(error.message);
        return;
      }
      throw error;
    }
  },
};
