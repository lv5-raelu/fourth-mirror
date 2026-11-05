import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { ChatInputCommandInteraction, Client, MessageComponentInteraction } from 'discord.js';
import type { BotContext } from '../types.ts';
import type { PendingWork } from '../lifecycle.ts';
import { allowsGuild } from '../config-values.ts';
import { ChatError } from '../chat/types.ts';
import { browseMessage, isBetaShare } from '../beta/browser.ts';
import { prepareSharedMessage } from '../beta/share-image.ts';
import { nodeBetaMessage } from '../beta/node-message.ts';
import type { BetaMessage, BetaRow } from '../beta/types.ts';

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  try {
    if (!allowsGuild(context.config, interaction.guildId)) {
      await interaction.reply({
        content: 'This bot is not enabled in this server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const command = context.commands.get(interaction.commandName);

    if (!command) {
      await interaction.reply({
        content: 'That command is no longer available. The bot owner needs to sync commands.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await command.execute(interaction, context);
  } catch (error) {
    context.logger.error(`Command /${interaction.commandName} failed.`, error);

    try {
      const content = 'Something went wrong running that command. Please try again later.';

      if (interaction.replied) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else if (interaction.deferred) {
        // Complete the pending response rather than leaving a permanent loading state.
        await interaction.editReply({ content });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      // Expired interactions and unavailable Discord connections must not become unhandled rejections.
      context.logger.error('Could not send the command error response.', replyError);
    }
  }
}

export async function handleBetaComponent(interaction: MessageComponentInteraction, context: BotContext): Promise<void> {
  const share = isBetaShare(interaction.customId);
  try {
    // Public selectors open a private view. Private navigation edits the same message.
    if (!share && interaction.message.flags.has(MessageFlags.Ephemeral)) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!allowsGuild(context.config, interaction.guildId)) throw new ChatError('This bot is not enabled in this server.');
    if (!context.beta) throw new ChatError('The beta archive is not available in this runtime.');
    if (share) {
      const channel = interaction.channel;
      if (!channel?.isSendable()) throw new ChatError('I cannot share beta information in this channel.');
      const sendPermission = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
      const member = interaction.member;
      const timeout = member && 'communicationDisabledUntilTimestamp' in member ? member.communicationDisabledUntilTimestamp
        : member && 'communication_disabled_until' in member ? Date.parse(member.communication_disabled_until ?? '') : 0;
      if (!interaction.memberPermissions?.has([PermissionFlagsBits.ViewChannel, sendPermission]) || (timeout ?? 0) > Date.now()) {
        throw new ChatError('You need permission to send messages in this channel to share beta information.');
      }
      if (!interaction.appPermissions?.has([PermissionFlagsBits.ViewChannel, sendPermission, PermissionFlagsBits.EmbedLinks])) {
        throw new ChatError('I need View Channel, Send Messages, and Embed Links here to share beta information.');
      }
      // Copy the displayed snapshot, including an AI answer, without another source or model request.
      const payload: BetaMessage = { embeds: interaction.message.embeds.map(embed => ({ ...embed.toJSON(),
        title: embed.title ?? 'HSR Beta', color: embed.color ?? 0xce6687, footer: { text: embed.footer?.text ?? 'Gachabase • Unofficial beta data' } })),
        components: interaction.message.components.map(row => row.toJSON()) as BetaRow[] };
      if (!payload.embeds.length) throw new ChatError('There is no beta information on this message to share.');
      if (payload.embeds.some(embed => embed.image) && !interaction.appPermissions?.has(PermissionFlagsBits.AttachFiles)) {
        throw new ChatError('I need Attach Files permission here to share comparison images.');
      }
      await channel.send({ ...nodeBetaMessage(await prepareSharedMessage(payload)), nonce: interaction.id, enforceNonce: true, allowedMentions: { parse: [] } });
      await interaction.editReply({ content: 'Shared this page to the channel.', allowedMentions: { parse: [] } });
      return;
    }
    await interaction.editReply({ ...nodeBetaMessage(await browseMessage(context.beta.client, interaction.customId,
      interaction.isStringSelectMenu() ? interaction.values : [], Boolean(interaction.appPermissions?.has(PermissionFlagsBits.AttachFiles)))), allowedMentions: { parse: [] } });
  } catch (error) {
    if (!(error instanceof ChatError)) context.logger.error('Beta interaction failed.', error);
    const payload = { content: error instanceof ChatError ? error.message : 'I could not complete that beta action. Please try again.', embeds: [], components: [], attachments: [], allowedMentions: { parse: [] as [] } };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch (replyError) { context.logger.error('Could not send the beta interaction error response.', replyError); }
  }
}

export function registerInteractionCreate(client: Client, context: BotContext, work: PendingWork): void {
  client.on(Events.InteractionCreate, (interaction) => {
    const task = interaction.isChatInputCommand() ? () => handleCommand(interaction, context)
      : interaction.isMessageComponent() && interaction.customId.startsWith('beta:') ? () => handleBetaComponent(interaction, context) : undefined;
    if (!task) return;
    void work.run(task).catch(() => {
      context.logger.error('Unexpected failure handling a command.');
    });
  });
}
