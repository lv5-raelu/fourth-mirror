import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ChannelType, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, Message } from 'discord.js';
import { ChatService } from '../src/chat/service.ts';
import { ChatStore } from '../src/chat/store.ts';
import { chat as chatCommand } from '../src/commands/chat.ts';
import { reset } from '../src/commands/reset.ts';
import { handleChatMessage } from '../src/events/message-create.ts';
import type { BotContext } from '../src/types.ts';

const ownerId = '123456789012345678';
const threadId = '223456789012345678';
const guildId = '323456789012345678';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'fourth-mirror-discord-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputs: string[] = [];
  const service = new ChatService({ reply: async (messages) => { inputs.push(messages.at(-1)!.content); return '@everyone ' + 'x'.repeat(2_200); } }, await ChatStore.open(join(directory, 'chats.json')));
  const context: BotContext = {
    config: { token: 'unused', applicationId: '423456789012345678', guildId, ai: null },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    commands: new Map(),
    chat: service,
  };
  return { context, service, inputs };
}

test('only the owner’s text in a registered private thread reaches the AI, with mentions disabled', async (t) => {
  const { context, service, inputs } = await setup(t);
  await service.create(ownerId, async () => threadId);
  const sent: { content: string; allowedMentions: { parse: string[]; repliedUser: boolean } }[] = [];
  const message = {
    guildId, channelId: threadId, author: { id: ownerId, bot: false }, webhookId: null, system: false,
    attachments: new Map(), stickers: new Map(), content: 'Hello',
    channel: { type: ChannelType.PrivateThread, send: async (payload: typeof sent[number]) => { sent.push(payload); }, sendTyping: async () => {} },
  };
  const ignored = [
    { ...message, guildId: '523456789012345678' },
    { ...message, author: { id: ownerId, bot: true } },
    { ...message, webhookId: 'webhook' },
    { ...message, system: true },
    { ...message, author: { id: '623456789012345678', bot: false } },
    { ...message, channelId: '723456789012345678' },
    { ...message, channel: { ...message.channel, type: ChannelType.GuildText } },
  ];
  for (const candidate of ignored) await handleChatMessage(candidate as unknown as Message, context);
  assert.equal(inputs.length, 0);
  assert.equal(sent.length, 0);

  await handleChatMessage({ ...message, attachments: new Map([['attachment', {}]]) } as unknown as Message, context);
  assert.equal(inputs.length, 0);
  assert.match(sent[0]!.content, /without attachments/);
  sent.length = 0;

  await handleChatMessage(message as unknown as Message, context);
  assert.deepEqual(inputs, ['Hello']);
  assert.equal(sent.length, 2);
  assert.equal(sent.map((payload) => payload.content).join(''), '@everyone ' + 'x'.repeat(2_200));
  assert.ok(sent.every((payload) => payload.content.length <= 2_000));
  assert.ok(sent.every((payload) => payload.allowedMentions.parse.length === 0 && !payload.allowedMentions.repliedUser));
});

test('/chat creates an invite-only private thread, records its owner, and /reset clears its context', async (t) => {
  const { context, service } = await setup(t);
  const threadOptions: Record<string, unknown>[] = [];
  const invited: string[] = [];
  const replies: string[] = [];
  const deferred: unknown[] = [];
  const channel = {
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    threads: {
      create: async (options: Record<string, unknown>) => {
        threadOptions.push(options);
        return { id: threadId, members: { add: async (userId: string) => { invited.push(userId); } }, send: async () => {}, setArchived: async () => {} };
      },
    },
  };
  const interaction = {
    channelId: '523456789012345678', user: { id: ownerId, displayName: 'Rae' },
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel } },
    deferReply: async (options: unknown) => { deferred.push(options); },
    editReply: async (content: string) => { replies.push(content); },
  };
  await chatCommand.execute(interaction as unknown as ChatInputCommandInteraction, context);
  assert.equal(threadOptions[0]?.type, ChannelType.PrivateThread);
  assert.equal(threadOptions[0]?.invitable, false);
  assert.deepEqual(invited, [ownerId]);
  assert.deepEqual(deferred[0], { flags: MessageFlags.Ephemeral });
  assert.equal(service.getSession(threadId)?.ownerId, ownerId);
  assert.match(replies[0]!, new RegExp(threadId));

  await service.reply(threadId, ownerId, 'Remember this', async () => {});
  await reset.execute({ ...interaction, channelId: threadId } as unknown as ChatInputCommandInteraction, context);
  assert.deepEqual(service.getSession(threadId)?.history, []);
  assert.match(replies.at(-1)!, /context cleared/);
});

test('/chat refuses missing permissions before creating a thread and archives a failed invitation', async (t) => {
  const { context } = await setup(t);
  let creates = 0;
  let archives = 0;
  let reply = '';
  let hasPermission = false;
  const channel = {
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => hasPermission }),
    threads: { create: async () => {
      creates++;
      return {
        id: threadId,
        members: { add: async () => { throw new Error('Invitation failed'); } },
        setArchived: async () => { archives++; },
      };
    } },
  };
  const interaction = {
    channelId: threadId, user: { id: ownerId, displayName: 'Rae' },
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel } },
    deferReply: async () => {}, editReply: async (content: string) => { reply = content; },
  };
  await chatCommand.execute(interaction as unknown as ChatInputCommandInteraction, context);
  assert.match(reply, /permissions/);
  assert.equal(creates, 0);
  hasPermission = true;
  await assert.rejects(chatCommand.execute(interaction as unknown as ChatInputCommandInteraction, context), /Invitation failed/);
  assert.equal(archives, 1);
  assert.equal(context.chat?.getSession(threadId), undefined);
});

test('/chat explains missing configuration without contacting Discord', async (t) => {
  const { context } = await setup(t);
  let reply = '';
  const interaction = { reply: async (payload: { content: string }) => { reply = payload.content; } };
  await chatCommand.execute(interaction as unknown as ChatInputCommandInteraction, { ...context, chat: null });
  assert.match(reply, /not configured/);
});
