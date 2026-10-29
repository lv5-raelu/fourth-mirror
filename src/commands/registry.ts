import type { Command } from '../types.ts';

export function createCommandRegistry(commands: readonly Command[]): ReadonlyMap<string, Command> {
  const registry = new Map<string, Command>();

  for (const command of commands) {
    // Validate builders locally before opening a connection or registering anything.
    command.data.toJSON();

    if (registry.has(command.data.name)) {
      throw new Error(`Duplicate command: /${command.data.name}`);
    }

    registry.set(command.data.name, command);
  }

  return registry;
}
