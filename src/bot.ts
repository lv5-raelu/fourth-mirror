import { Client, Events, GatewayIntentBits } from 'discord.js';
import { commands } from './commands/index.ts';
import type { Config } from './config.ts';
import { registerEvents } from './events/index.ts';
import { logger } from './logger.ts';
import { OpenAICompatibleProvider } from './chat/provider.ts';
import { ChatService } from './chat/service.ts';
import { ChatStore } from './chat/store.ts';

export async function createBot(config: Config): Promise<Client> {
  const chat = config.ai
    ? new ChatService(new OpenAICompatibleProvider(config.ai), await ChatStore.open(config.ai.historyFile))
    : null;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      ...(chat ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] : []),
    ],
    allowedMentions: { parse: [], repliedUser: false },
  });

  registerEvents(client, { config, commands, logger, chat });
  if (!chat) logger.info('AI chat is disabled. Set AI_API_KEY and AI_MODEL to enable it.');

  client.on(Events.Error, (error) => logger.error('Discord client error.', error));
  client.on(Events.ShardError, (error) => logger.error('Discord gateway error.', error));
  client.on(Events.Warn, (message) => logger.warn(message));

  return client;
}
