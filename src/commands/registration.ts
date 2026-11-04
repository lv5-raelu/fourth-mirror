import { Routes } from 'discord.js';
import type { REST } from 'discord.js';
import type { Config } from '../config-values.ts';
import { commands } from './index.ts';

export function globalCommandBody() {
  return [...commands.values()].map(command => ({ ...command.data.toJSON(), contexts: [0], integration_types: [0] }));
}

export async function syncApplicationCommands(rest: Pick<REST, 'put'>, config: Pick<Config, 'applicationId' | 'guildId'>): Promise<void> {
  // Publish first. If this fails, the previous server's commands remain available.
  await rest.put(Routes.applicationCommands(config.applicationId), { body: globalCommandBody() });
  if (config.guildId) {
    // Retire the application's old guild-scoped registry so it cannot shadow global updates.
    await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: [] });
  }
}
