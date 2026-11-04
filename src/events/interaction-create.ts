import { Events, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, Client } from 'discord.js';
import type { BotContext } from '../types.ts';
import type { PendingWork } from '../lifecycle.ts';

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  try {
    if (interaction.guildId !== context.config.guildId) {
      await interaction.reply({
        content: 'This bot is configured for a different server.',
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

export function registerInteractionCreate(client: Client, context: BotContext, work: PendingWork): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    void work.run(() => handleCommand(interaction, context)).catch(() => {
      context.logger.error('Unexpected failure handling a command.');
    });
  });
}
