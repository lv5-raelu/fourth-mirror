import { Events } from 'discord.js';
import type { Client } from 'discord.js';
import type { BotContext } from '../types.ts';

export function registerReady(client: Client, context: BotContext): void {
  client.once(Events.ClientReady, (readyClient) => {
    context.logger.info(`Logged in as ${readyClient.user.tag}.`, {
      servers: readyClient.guilds.cache.size,
      commands: context.commands.size,
    });

    if (context.config.guildIds?.some(id => !readyClient.guilds.cache.has(id))) {
      context.logger.warn('An allowed server is unavailable. Check DISCORD_GUILD_IDS and the bot invitations.');
    }
  });
}
