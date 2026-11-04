import { commandDefinitions } from './definitions.ts';
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types.ts';

export const ping: Command = {
  data: new SlashCommandBuilder()
    .setName(commandDefinitions.ping.name)
    .setDescription(commandDefinitions.ping.description),
  async execute(interaction) {
    const heartbeat = interaction.client.ws.ping;
    const latency = heartbeat < 0 ? 'measuring…' : `${Math.round(heartbeat)} ms`;

    await interaction.reply({
      content: `Pong! Gateway heartbeat: ${latency}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
