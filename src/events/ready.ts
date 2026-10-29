import { Events } from 'discord.js';
import type { Client } from 'discord.js';
import type { BotContext } from '../types.ts';

export function registerReady(client: Client, context: BotContext): void {
  client.once(Events.ClientReady, (readyClient) => {
    context.logger.info(`Logged in as ${readyClient.user.tag}.`, {
      guildId: context.config.guildId,
      commands: context.commands.size,
    });

    if (!readyClient.guilds.cache.has(context.config.guildId)) {
      context.logger.warn('The configured server is unavailable. Check DISCORD_GUILD_ID and the bot invitation.');
    }
  });
}
