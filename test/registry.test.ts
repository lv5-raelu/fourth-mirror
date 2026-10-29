import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCommandRegistry } from '../src/commands/registry.ts';
import type { Command } from '../src/types.ts';

function command(name: string): Command {
  return {
    data: {
      name,
      description: `Test ${name}`,
      toJSON: () => ({ type: 1, name, description: `Test ${name}` }),
    },
    execute: async () => {},
  };
}

test('looks up commands by name', () => {
  const ping = command('ping');
  const help = command('help');
  const registry = createCommandRegistry([ping, help]);

  assert.equal(registry.size, 2);
  assert.equal(registry.get('ping'), ping);
  assert.equal(registry.get('help'), help);
  assert.equal(registry.get('removed'), undefined);
});

test('fails before startup when two commands have the same name', () => {
  assert.throws(
    () => createCommandRegistry([command('ping'), command('ping')]),
    /Duplicate command: \/ping/,
  );
});

test('validates command definitions before they can be deployed or handled', () => {
  const invalid = command('invalid');
  invalid.data.toJSON = () => { throw new Error('Invalid slash-command definition'); };

  assert.throws(() => createCommandRegistry([invalid]), /Invalid slash-command definition/);
});

test('allows an empty command registry', () => {
  assert.equal(createCommandRegistry([]).size, 0);
});
