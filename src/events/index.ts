import type { Client } from 'discord.js';
import type { BotContext } from '../types.ts';
import type { PendingWork } from '../lifecycle.ts';
import { registerInteractionCreate } from './interaction-create.ts';
import { registerReady } from './ready.ts';
import { registerMessageCreate } from './message-create.ts';

export function registerEvents(client: Client, context: BotContext, work: PendingWork): void {
  registerReady(client, context);
  registerInteractionCreate(client, context, work);
  registerMessageCreate(client, context, work);
  // Track future asynchronous listeners with work.run() so shutdown waits for them.
}
