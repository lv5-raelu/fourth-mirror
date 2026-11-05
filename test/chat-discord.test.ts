import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ChannelType, DiscordAPIError, MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import type { ChatInputCommandInteraction, Message } from 'discord.js';
import { ChatService } from '../src/chat/service.ts';
import { ChatStore } from '../src/chat/store.ts';
import type { ChatContext } from '../src/chat/types.ts';
import type { ChatMessage } from '../src/chat/types.ts';
import { imageUrl } from './fixtures/media.ts';
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
  const contexts: (ChatContext | undefined)[] = [];
  const turns: (readonly ChatMessage[])[] = [];
  const service = new ChatService({ reply: async (messages, context) => { turns.push(messages); inputs.push(messages.at(-1)!.content); contexts.push(context); return '@everyone ' + 'x'.repeat(2_200); } }, await ChatStore.open(join(directory, 'chats.json')));
  const context: BotContext = {
    config: { token: 'unused', applicationId: '423456789012345678', guildId, ai: null, web: null },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    commands: new Map(),
    chat: service,
  };
  return { context, service, inputs, contexts, turns };
}

test('media-only personal, group, and standalone messages reach the shared chat path', async t => {
  const botId = '423456789012345678';
  for (const mode of ['personal', 'group', 'standalone'] as const) {
    const { context, service, turns } = await setup(t);
    if (mode !== 'standalone') await service.create(ownerId, async () => threadId, mode);
    const sent: { content: string }[] = [];
    const addressed = mode !== 'personal';
    const message = {
      id: '923456789012345678', guildId, channelId: threadId, author: { id: ownerId, bot: false, displayName: 'Rae' }, webhookId: null, system: false,
      content: addressed ? '<@' + botId + '>' : '', client: { user: { id: botId }, rest: { get: async () => [] } },
      mentions: { users: new Map([[botId, {}]]) }, stickers: new Map(),
      attachments: new Map([['image', { url: imageUrl, name: 'screen.png', size: 100, contentType: 'image/png' }]]),
      channel: { type: mode === 'personal' ? ChannelType.PrivateThread : mode === 'group' ? ChannelType.PublicThread : ChannelType.GuildText,
        send: async (payload: { content: string }) => { sent.push(payload); }, sendTyping: async () => {},
      },
    };
    await handleChatMessage(message as unknown as Message, context);
    assert.equal(turns.length, 1, mode);
    assert.equal(turns[0]?.[0]?.content, 'Respond to the attached media.');
    assert.equal(turns[0]?.[0]?.media?.[0]?.url, imageUrl);
    assert.equal(sent.length, 2);
    assert.equal(Boolean(service.getSession(threadId)), mode !== 'standalone');
  }
});

test('only the owner’s text in a registered private thread reaches the AI, with mentions disabled', async (t) => {
  const { context, service, inputs } = await setup(t);
  await service.create(ownerId, async () => threadId);
  const sent: { content: string; flags: MessageFlags; allowedMentions: { parse: string[]; repliedUser: boolean } }[] = [];
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
    { ...message, channel: { ...message.channel, type: ChannelType.PublicThread } },
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
  assert.ok(sent.every((payload) => payload.flags === MessageFlags.SuppressEmbeds && payload.allowedMentions.parse.length === 0 && !payload.allowedMentions.repliedUser));
});

test('/chat creates a private thread without parent-channel Send Messages, records its owner, and /reset clears its context', async (t) => {
  const { context, service } = await setup(t);
  const threadOptions: Record<string, unknown>[] = [];
  const invited: string[] = [];
  const replies: string[] = [];
  const deferred: unknown[] = [];
  const permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads]);
  const channel = {
    type: ChannelType.GuildText,
    permissionsFor: () => permissions,
    threads: {
      create: async (options: Record<string, unknown>) => {
        threadOptions.push(options);
        return { id: threadId, members: { add: async (userId: string) => { invited.push(userId); } }, send: async () => {}, setArchived: async () => {} };
      },
    },
  };
  const interaction = {
    options: { getString: () => null },
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
  const permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessagesInThreads]);
  const channel = {
    type: ChannelType.GuildText,
    permissionsFor: () => permissions,
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
    options: { getString: () => null },
    channelId: threadId, user: { id: ownerId, displayName: 'Rae' },
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel } },
    deferReply: async () => {}, editReply: async (content: string) => { reply = content; },
  };
  await chatCommand.execute(interaction as unknown as ChatInputCommandInteraction, context);
  assert.equal(reply, 'Missing bot permissions here: Create Private Threads. Check this channel’s permission overrides.');
  assert.equal(creates, 0);
  permissions.add(PermissionFlagsBits.CreatePrivateThreads);
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

test('/chat group creates a public thread without private-thread or parent-channel Send Messages permissions', async t => {
  const { context, service } = await setup(t);
  let invitable: unknown;
  let type: unknown;
  let welcome = '';
  const permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads]);
  const channel = { type: ChannelType.GuildText, permissionsFor: () => permissions, threads: {
    create: async (options: Record<string, unknown>) => {
      invitable = options.invitable;
      type = options.type;
      return { id: threadId, members: { add: async () => {} }, send: async (payload: { content: string }) => { welcome = payload.content; }, setArchived: async () => {} };
    },
  } };
  const interaction = {
    options: { getString: () => 'group' }, channelId: '523456789012345678', user: { id: ownerId, displayName: 'Rae' },
    client: { user: { id: 'bot' }, channels: { fetch: async () => channel } }, deferReply: async () => {}, editReply: async () => {},
  };
  await chatCommand.execute(interaction as unknown as ChatInputCommandInteraction, context);
  assert.equal(type, ChannelType.PublicThread);
  assert.equal(invitable, undefined);
  assert.equal(service.getSession(threadId)?.mode, 'group');
  assert.match(welcome, /Mention me or reply/);
  assert.match(welcome, /Anyone who can view the parent channel/);
});

test('group members can mention or reply to the bot, while side conversations stay outside AI history', async t => {
  const { context, service, inputs } = await setup(t);
  await service.create(ownerId, async () => threadId, 'group');
  const botId = '823456789012345678';
  const peer = '623456789012345678';
  const sent: { content: string; flags: MessageFlags; reply?: { messageReference: string }; allowedMentions: { parse: string[]; repliedUser: boolean } }[] = [];
  const base = {
    id: '923456789012345678', guildId, channelId: threadId, author: { id: peer, bot: false, displayName: 'Alex' },
    client: { user: { id: botId } }, mentions: { users: new Map() }, member: { displayName: 'Alex' },
    webhookId: null, system: false, attachments: new Map(), stickers: new Map(), content: 'Just talking to a friend',
    channel: { type: ChannelType.PublicThread, send: async (payload: typeof sent[number]) => { sent.push(payload); }, sendTyping: async () => {} },
  };
  await handleChatMessage(base as unknown as Message, context);
  await handleChatMessage({ ...base, reference: { type: 0, messageId: '933456789012345678', channelId: threadId },
    fetchReference: async () => ({ author: { id: ownerId } }),
  } as unknown as Message, context);
  assert.equal(inputs.length, 0);
  assert.equal(sent.length, 0);

  await handleChatMessage({ ...base, content: '<@' + botId + '> Explain this', mentions: { users: new Map([[botId, {}]]) } } as unknown as Message, context);
  assert.deepEqual(inputs, ['Explain this']);
  assert.ok(sent.every(payload => payload.reply?.messageReference === base.id));
  assert.ok(sent.every(payload => payload.flags === MessageFlags.SuppressEmbeds && payload.allowedMentions.parse.length === 0 && !payload.allowedMentions.repliedUser));
  await handleChatMessage({ ...base, id: '943456789012345678', author: { ...base.author, id: '723456789012345678' }, content: 'What about the follow-up?',
    reference: { type: 0, messageId: '953456789012345678', channelId: threadId }, fetchReference: async () => ({ author: { id: botId }, webhookId: null }),
  } as unknown as Message, context);
  assert.equal(inputs.length, 2);
  const history = service.getSession(threadId)!.history;
  assert.equal(history.length, 4);
  assert.equal(history[0]?.speaker?.id, peer);
  assert.equal(history[2]?.speaker?.id, '723456789012345678');
});

test('an older bot reply keeps its place ahead of a later mention while its reference is fetched', async t => {
  const { context, service, inputs } = await setup(t);
  await service.create(ownerId, async () => threadId, 'group');
  const botId = '823456789012345678';
  let resolveReference!: (value: { author: { id: string }; webhookId: null }) => void;
  const reference = new Promise<{ author: { id: string }; webhookId: null }>(resolve => { resolveReference = resolve; });
  const base = {
    id: '923456789012345678', guildId, channelId: threadId, author: { id: ownerId, bot: false, displayName: 'Rae' },
    client: { user: { id: botId } }, mentions: { users: new Map() }, webhookId: null, system: false,
    attachments: new Map(), stickers: new Map(), content: 'First question',
    channel: { type: ChannelType.PrivateThread, send: async () => {}, sendTyping: async () => {} },
  };
  const first = handleChatMessage({ ...base, reference: { type: 0, messageId: '953456789012345678', channelId: threadId }, fetchReference: () => reference } as unknown as Message, context);
  const second = handleChatMessage({ ...base, id: '943456789012345678', author: { id: '623456789012345678', bot: false, displayName: 'Alex' },
    content: '<@' + botId + '> Second question', mentions: { users: new Map([[botId, {}]]) },
  } as unknown as Message, context);
  await Promise.resolve();
  assert.equal(inputs.length, 0);
  resolveReference({ author: { id: botId }, webhookId: null });
  await Promise.all([first, second]);
  assert.deepEqual(inputs, ['First question', 'Second question']);
});

test('channel mentions answer in place with recent context, while ordinary replies and non-user events are ignored', async t => {
  const { context, service, inputs, contexts } = await setup(t);
  const botId = '823456789012345678';
  const channelId = '723456789012345678';
  const sent: { content: string; flags: MessageFlags; reply?: { messageReference: string }; allowedMentions: { parse: string[]; repliedUser: boolean } }[] = [];
  const reads: unknown[] = [];
  const channel = {
    type: ChannelType.GuildText,
    send: async (payload: typeof sent[number]) => { sent.push(payload); }, sendTyping: async () => {},
  };
  const rest = { get: async (route: string, options: { query?: URLSearchParams; signal: AbortSignal }) => {
    assert.ok(options.signal instanceof AbortSignal);
    reads.push({ route, ...(options.query ? { before: options.query.get('before'), limit: options.query.get('limit') } : {}) });
    if (!options.query) return { id: '901456789012345678', channel_id: channelId, content: 'The original schedule.', author: { username: 'Organizer' } };
    return [
      { id: '903456789012345678', content: 'That sounds useful.', author: { id: botId, global_name: 'Fourth Mirror' } },
      { id: '902456789012345678', content: 'The event starts at noon.', author: { username: 'Alex' },
        message_reference: { message_id: '901456789012345678', channel_id: channelId } },
    ];
  } };
  const base = {
    id: '923456789012345678', guildId, channelId, author: { id: ownerId, bot: false, displayName: 'Rae' },
    client: { user: { id: botId }, rest }, mentions: { users: new Map([[botId, {}]]) },
    webhookId: null, system: false, attachments: new Map(), stickers: new Map(),
    content: '<@!' + botId + '> When does the event start?', channel,
  };
  for (const candidate of [
    { ...base, content: 'An ordinary channel message', mentions: { users: new Map() } },
    { ...base, content: 'What about later?', reference: { messageId: 'bot-answer' } },
    { ...base, guildId: '523456789012345678' },
    { ...base, guildId: null, channel: { ...channel, type: ChannelType.DM } },
    { ...base, author: { ...base.author, bot: true } },
    { ...base, webhookId: 'webhook' }, { ...base, system: true },
  ]) await handleChatMessage(candidate as unknown as Message, context);
  assert.equal(inputs.length, 0);
  assert.equal(reads.length, 0);
  await handleChatMessage(base as unknown as Message, context);
  assert.deepEqual(inputs, ['When does the event start?']);
  assert.deepEqual(reads, [{ route: '/channels/' + channelId + '/messages', before: base.id, limit: '30' },
    { route: '/channels/' + channelId + '/messages/901456789012345678' }]);
  assert.deepEqual(contexts[0], { questionAuthor: 'Rae', recentMessages: [
    { id: '902456789012345678', author: 'Alex', content: 'The event starts at noon.', replyTo: '901456789012345678' },
    { id: '903456789012345678', author: 'Fourth Mirror', content: 'That sounds useful.', isOwnReply: true },
  ], referencedMessages: [{ id: '901456789012345678', author: 'Organizer', content: 'The original schedule.' }] });
  assert.equal(service.getSession(channelId), undefined);
  assert.ok(sent.every(payload => payload.reply?.messageReference === base.id && payload.flags === MessageFlags.SuppressEmbeds && payload.allowedMentions.parse.length === 0 && !payload.allowedMentions.repliedUser));
  const calls = inputs.length;
  await handleChatMessage({ ...base, content: 'And tomorrow?', reference: { messageId: 'bot-answer' } } as unknown as Message, context);
  assert.equal(inputs.length, calls);
});

test('one-off mentions handle unavailable history and can send without a linked reply when history permission is missing', async t => {
  const { context, inputs, contexts } = await setup(t);
  const botId = '823456789012345678';
  const sent: Record<string, unknown>[] = [];
  let attempts = 0;
  const channel = {
    type: ChannelType.GuildAnnouncement,
    sendTyping: async () => {},
    send: async (payload: Record<string, unknown>) => {
      attempts++;
      if (payload.reply) throw new DiscordAPIError({ code: 50013, message: 'Missing Permissions' }, 50013, 403, 'POST', 'https://discord.com/api/v10/channels/unused/messages', {});
      sent.push(payload);
    },
  };
  const base = {
    id: '923456789012345678', guildId, channelId: '723456789012345678', author: { id: ownerId, bot: false, displayName: 'Rae' },
    client: { user: { id: botId }, rest: { get: async () => { throw new Error('History unavailable'); } } }, mentions: { users: new Map([[botId, {}]]) },
    webhookId: null, system: false, attachments: new Map(), stickers: new Map(), channel,
  };
  await handleChatMessage({ ...base, content: '<@' + botId + '>' } as unknown as Message, context);
  assert.equal(inputs.length, 0);
  assert.match(String(sent[0]?.content), /text question/);
  sent.length = 0; attempts = 0;
  await handleChatMessage({ ...base, content: '<@' + botId + '> A standalone question' } as unknown as Message, context);
  assert.deepEqual(inputs, ['A standalone question']);
  assert.deepEqual(contexts[0]?.recentMessages, []);
  assert.equal(attempts, 4);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(payload => !payload.reply));
});
