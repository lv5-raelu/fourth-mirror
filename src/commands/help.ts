import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types.ts';

export const help: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('See the available commands.'),
  async execute(interaction, { commands }) {
    const lines = [...commands.values()]
      .sort((a, b) => a.data.name.localeCompare(b.data.name))
      .map(({ data }) => `**/${data.name}** — ${data.description}`);

    await interaction.reply({
      content: ['Available commands:', ...lines].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  },
};
