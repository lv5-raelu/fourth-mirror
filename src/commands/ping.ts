import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types.ts';

export const ping: Command = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether the bot is awake.'),
  async execute(interaction) {
    const heartbeat = interaction.client.ws.ping;
    const latency = heartbeat < 0 ? 'measuring…' : `${Math.round(heartbeat)} ms`;

    await interaction.reply({
      content: `Pong! Gateway heartbeat: ${latency}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
