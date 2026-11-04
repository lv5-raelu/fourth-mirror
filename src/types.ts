import type { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import type { ChatService } from './chat/service.ts';
import type { BetaFeature } from './beta/feature.ts';

export interface Command {
  readonly data: Pick<SlashCommandBuilder, 'name' | 'description' | 'toJSON'>;
  execute(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void>;
}

export interface BotContext {
  readonly config: Config;
  readonly logger: Logger;
  readonly commands: ReadonlyMap<string, Command>;
  readonly chat: ChatService | null;
  readonly beta?: BetaFeature;
}
