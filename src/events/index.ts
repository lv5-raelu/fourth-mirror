import type { Client } from 'discord.js';
import type { BotContext } from '../types.ts';
import { registerInteractionCreate } from './interaction-create.ts';
import { registerReady } from './ready.ts';
import { registerMessageCreate } from './message-create.ts';

export function registerEvents(client: Client, context: BotContext): void {
  registerReady(client, context);
  registerInteractionCreate(client, context);
  registerMessageCreate(client, context);
  // Register future message, member, reaction, or component listeners here.
}
