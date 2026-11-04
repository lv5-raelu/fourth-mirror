import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChannelType, Events } from 'discord.js';
import type { Client } from 'discord.js';
import { ChatService } from '../src/chat/service.ts';
import { ChatStore } from '../src/chat/store.ts';
import { registerInteractionCreate } from '../src/events/interaction-create.ts';
import { registerMessageCreate } from '../src/events/message-create.ts';
import { PendingWork } from '../src/lifecycle.ts';
import type { BotContext, Command } from '../src/types.ts';

const ownerId = '123456789012345678';
const threadId = '223456789012345678';
const guildId = '323456789012345678';
const logger = { info: () => {}, warn: () => {}, error: () => {} };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('shutdown waits for an active AI reply to be delivered and persisted, and stops accepting messages', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fourth-mirror-shutdown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'chats.json');
  const providerStarted = deferred<void>();
  const answer = deferred<string>();
  let calls = 0;
  const chat = new ChatService({ reply: () => {
    calls++;
    providerStarted.resolve();
    return answer.promise;
  } }, await ChatStore.open(file));
  await chat.create(ownerId, async () => threadId);
  const context: BotContext = {
    config: { token: 'unused', applicationId: '423456789012345678', guildId, ai: null, web: null },
    logger, commands: new Map(), chat,
  };
  const client = new EventEmitter();
  const work = new PendingWork();
  registerMessageCreate(client as Client, context, work);
  const sent: string[] = [];
  const message = {
    guildId, channelId: threadId, author: { id: ownerId, bot: false }, webhookId: null, system: false,
    attachments: new Map(), stickers: new Map(), content: 'Remember this through the update.',
    channel: {
      type: ChannelType.PrivateThread,
      send: async (payload: { content: string }) => { sent.push(payload.content); },
      sendTyping: async () => {},
    },
  };
  client.emit(Events.MessageCreate, message);
  await providerStarted.promise;
  let stopped = false;
  const shutdown = work.drain().then(() => { stopped = true; });
  client.emit(Events.MessageCreate, { ...message, content: 'Arrived during shutdown' });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(sent.length, 0);

  answer.resolve('I will remember.');
  await shutdown;
  assert.equal(calls, 1);
  assert.deepEqual(sent, ['I will remember.']);
  assert.deepEqual((await ChatStore.open(file)).get(threadId)?.history, [
    { role: 'user', content: message.content },
    { role: 'assistant', content: 'I will remember.' },
  ]);
  client.emit(Events.MessageCreate, message);
  await work.drain();
  assert.equal(calls, 1);
});

test('shutdown also waits for active commands and ignores new interactions', async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  let calls = 0;
  const command: Command = {
    data: { name: 'slow', description: 'Test command', toJSON: () => ({ name: 'slow', description: 'Test command' }) },
    execute: async () => { calls++; started.resolve(); await finish.promise; },
  };
  const context: BotContext = {
    config: { token: 'unused', applicationId: '423456789012345678', guildId, ai: null, web: null },
    logger, commands: new Map([['slow', command]]), chat: null,
  };
  const client = new EventEmitter();
  const work = new PendingWork();
  registerInteractionCreate(client as Client, context, work);
  const interaction = { guildId, commandName: 'slow', isChatInputCommand: () => true };
  client.emit(Events.InteractionCreate, interaction);
  await started.promise;
  let stopped = false;
  const shutdown = work.drain().then(() => { stopped = true; });
  client.emit(Events.InteractionCreate, interaction);
  await Promise.resolve();
  assert.equal(stopped, false);
  finish.resolve();
  await shutdown;
  assert.equal(calls, 1);
});

test('a failed handler does not abort draining other accepted work', async () => {
  const work = new PendingWork();
  const finish = deferred<void>();
  const failed = work.run(() => { throw new Error('Handler failed'); });
  const rejection = assert.rejects(failed, /Handler failed/);
  const active = work.run(() => finish.promise);
  let stopped = false;
  const shutdown = work.drain().then(() => { stopped = true; });
  await rejection;
  assert.equal(stopped, false);
  finish.resolve();
  await Promise.all([active, shutdown]);
});
