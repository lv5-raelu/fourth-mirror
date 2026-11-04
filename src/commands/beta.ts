import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { commandDefinitions } from './definitions.ts';
import { executeBeta } from '../beta/feature.ts';
import { ChatError } from '../chat/types.ts';
import type { Command } from '../types.ts';

export const beta: Command = {
  data: new SlashCommandBuilder().setName(commandDefinitions.beta.name).setDescription(commandDefinitions.beta.description)
    .addSubcommand(option => option.setName('latest').setDescription('Browse the latest Gachabase beta revision.'))
    .addSubcommand(option => option.setName('ask').setDescription('Ask Fourth Mirror about HSR beta changes.')
      .addStringOption(option => option.setName('question').setDescription('Mention the character or item you want to investigate.').setRequired(true).setMaxLength(1_000)))
    .addSubcommand(option => option.setName('alerts').setDescription('Manage beta notifications (Manage Server required).')
      .addChannelOption(option => option.setName('channel').setDescription('The text channel for beta/spoiler updates.').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addBooleanOption(option => option.setName('enabled').setDescription('Turn alerts off, or on with a selected channel.'))),
  async execute(interaction, context) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!context.beta) { await interaction.editReply('The beta archive is not available in this runtime.'); return; }
    const question = interaction.options.getString('question');
    const channel = interaction.options.getChannel('channel');
    const enabled = interaction.options.getBoolean('enabled');
    try {
      await executeBeta({ action: interaction.options.getSubcommand(), userId: interaction.user.id,
        canManage: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
        ...(question !== null ? { question } : {}), ...(channel ? { channelId: channel.id } : {}), ...(enabled !== null ? { enabled } : {}),
      }, context.beta.forGuild(interaction.guildId!), context.chat, async payload => { await interaction.editReply({ ...payload, allowedMentions: { parse: [] } }); }, async id => {
        const target = await interaction.client.channels.fetch(id);
        if (!target || !('guildId' in target) || target.guildId !== interaction.guildId ||
          (target.type !== ChannelType.GuildText && target.type !== ChannelType.GuildAnnouncement)) throw new ChatError('Choose a regular text or announcement channel in this server.');
        if (!target.permissionsFor(interaction.client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          throw new ChatError('I need View Channel, Send Messages, and Embed Links in the notification channel.');
        }
      });
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      await interaction.editReply({ content: error.message, embeds: [], components: [], allowedMentions: { parse: [] } });
    }
  },
};
