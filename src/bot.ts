import { Client, Events, GatewayIntentBits } from 'discord.js';
import { commands } from './commands/index.ts';
import type { Config } from './config.ts';
import { registerEvents } from './events/index.ts';
import { logger } from './logger.ts';
import { OpenAICompatibleProvider } from './chat/provider.ts';
import { ChatService } from './chat/service.ts';
import { ChatStore } from './chat/store.ts';
import { DeepSeekWebProvider } from './chat/web/deepseek.ts';
import { PendingWork } from './lifecycle.ts';
import { dirname, join } from 'node:path';
import { BetaClient } from './beta/source.ts';
import { ServerBeta } from './beta/servers.ts';
import { allowsGuild } from './config-values.ts';
import { BetaFileStore } from './beta/file-store.ts';
import { overviewMessage, sharedMessage } from './beta/browser.ts';
import { nodeBetaMessage } from './beta/node-message.ts';

export interface Bot {
  readonly client: Client;
  stop(): Promise<void>;
}

export async function createBot(config: Config): Promise<Bot> {
  const chat = config.ai
    ? new ChatService(new OpenAICompatibleProvider(config.ai, config.web ? new DeepSeekWebProvider(config.web) : undefined), await ChatStore.open(config.ai.historyFile))
    : null;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      ...(chat ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] : []),
    ],
    allowedMentions: { parse: [], repliedUser: false },
  });

  const work = new PendingWork();
  const betaClient = new BetaClient();
  const beta = new ServerBeta(betaClient,
    await BetaFileStore.open(join(dirname(config.ai?.historyFile ?? 'data/chats.json'), 'beta-alerts.json')));
  registerEvents(client, { config, commands, logger, chat, beta }, work);
  const betaTimer = setInterval(() => {
    if (!client.isReady()) return;
    void work.run(() => beta.check(id => allowsGuild(config, id) && client.guilds.cache.has(id), async (guildId, channelId, revisions, checkedAt, nonce) => {
      const target = await client.channels.fetch(channelId);
      if (!target || !('guildId' in target) || target.guildId !== guildId ||
        (target.type !== 0 && target.type !== 5)) throw new Error('Invalid beta notification channel.');
      await target.send({ ...nodeBetaMessage(sharedMessage(await overviewMessage(betaClient, { checkedAt, revisions }, revisions))), nonce, enforceNonce: true, allowedMentions: { parse: [] } });
    })).catch(() => logger.warn('Beta notification check could not finish.'));
  }, 60_000);
  betaTimer.unref();
  if (!chat) logger.info('AI chat is disabled. Set AI_API_KEY and AI_MODEL to enable it.');

  client.on(Events.Error, (error) => logger.error('Discord client error.', error));
  client.on(Events.ShardError, (error) => logger.error('Discord gateway error.', error));
  client.on(Events.Warn, (message) => logger.warn(message));

  return {
    client,
    async stop() {
      clearInterval(betaTimer);
      chat?.cancelQueuedReplies();
      await work.drain();
      await client.destroy();
    },
  };
}
