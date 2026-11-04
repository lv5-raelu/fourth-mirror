import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelContext, loadChannelContext } from '../src/chat/context.ts';
import type { DiscordContextMessage } from '../src/chat/context.ts';
import { imageUrl } from './fixtures/media.ts';

const channelId = '333456789012345678';
const questionId = '923456789012345678';
const id = (value: number) => String(503456789012345678n + BigInt(value));
const message = (value: number, content = 'Message ' + value): DiscordContextMessage => ({
  id: id(value), channel_id: channelId, author: { username: 'User ' + value }, content,
});
const reply = (value: number, target: number): DiscordContextMessage => ({ ...message(value), type: 19,
  message_reference: { message_id: id(target), channel_id: channelId },
});

test('includes media-only history and the current question’s older direct reply target', async () => {
  const target = { ...message(1, ''), sticker_items: [{ id: '123456789012345678', name: 'Wave', format_type: 1 }] };
  const context = await loadChannelContext('Rae', channelId, questionId, {
    referenceId: target.id,
    recent: async () => [{ ...message(10, ''), attachments: [{ url: imageUrl, filename: 'screen.png', size: 100 }] }],
    message: async id => { assert.equal(id, target.id); return target; },
  });
  assert.equal(context.recentMessages[0]?.content, 'Media message');
  assert.equal(context.recentMessages[0]?.media?.[0]?.url, imageUrl);
  assert.equal(context.referencedMessages?.[0]?.media?.[0]?.name, 'Sticker: Wave');
});

test('channel context keeps recent messages in reading order with bounded text and author labels', () => {
  const context = channelContext('\u202eRae\n', [
    { author: 'Pat', content: 'The newer point' },
    { author: 'Alex\u0000', content: 'The earlier point' },
    { author: 'Empty', content: '  ' },
  ]);
  assert.deepEqual(context, { questionAuthor: 'Rae', recentMessages: [
    { author: 'Alex', content: 'The earlier point' }, { author: 'Pat', content: 'The newer point' },
  ] });
  const long = channelContext('Rae', Array.from({ length: 40 }, (_, i) => ({ id: id(100 - i), author: String(i), content: '🙂'.repeat(800) })),
    Array.from({ length: 30 }, (_, i) => ({ id: id(50 - i), author: 'Original ' + i, content: '🙂'.repeat(800) })));
  assert.equal(long.recentMessages.length, 30);
  assert.equal(long.referencedMessages?.length, 30);
  assert.equal(long.recentMessages.at(-1)?.author, '0');
  const all = [...long.recentMessages, ...long.referencedMessages!];
  assert.ok(all.every(message => message.content.length > 200 && message.content.length <= 1_000 && !/[\uD800-\uDFFF]/u.test(message.content)));
  assert.ok(all.reduce((sum, message) => sum + message.content.length, 0) <= 16_000);
  assert.ok(!long.recentMessages.some(message => Number(message.author) >= 30));
});

test('context preserves a full short explanation when the remaining budget fits it', () => {
  const context = channelContext('Rae', Array.from({ length: 29 }, () => ({ author: 'Alex', content: 'Short' })).concat([
    { author: 'Pat', content: 'x'.repeat(900) },
  ]));
  assert.equal(context.recentMessages[0]?.content.length, 900);
});

test('collects 30 messages and unique direct targets, reuses embedded and in-window messages, and never walks reply chains', async () => {
  const raw = Array.from({ length: 31 }, (_, i) => message(100 - i));
  raw[0] = { ...reply(100, 40), referenced_message: reply(40, 10) };
  raw[1] = reply(99, 40); // Same target, already embedded in another reply.
  raw[2] = reply(98, 30);
  raw[3] = reply(97, 30); // Same missing target, fetch only once.
  raw[4] = reply(96, 90); // Already in the 30-message window.
  raw[29] = reply(71, 20); // The oldest message inside the window still contributes its target.
  raw[30] = reply(70, 15); // Outside the window.
  const fetched: string[] = [];
  const context = await loadChannelContext('Rae', channelId, questionId, {
    recent: async limit => { assert.equal(limit, 30); return raw; },
    message: async target => { fetched.push(target); return target === id(30) ? reply(30, 5) : message(20); },
  });
  assert.deepEqual(fetched, [id(30), id(20)]);
  assert.equal(context.recentMessages.length, 30);
  assert.equal(context.recentMessages[0]?.id, id(71));
  assert.equal(context.recentMessages.at(-1)?.replyTo, id(40));
  assert.deepEqual(context.referencedMessages?.map(value => value.id), [id(40), id(30), id(20)]);
  assert.equal(new Set([...context.recentMessages, ...context.referencedMessages!].map(value => value.id)).size, 33);
});

test('skips deleted, inaccessible, forwarded, cross-channel, future, and mismatched reply targets', async () => {
  const raw: DiscordContextMessage[] = [
    { ...reply(100, 1), referenced_message: null },
    reply(99, 2), reply(98, 3), reply(97, 4),
    { ...reply(96, 5), message_reference: { type: 1, message_id: id(5), channel_id: channelId } },
    { ...reply(95, 6), message_reference: { message_id: id(6), channel_id: '433456789012345678' } },
    reply(94, 200),
    { ...reply(93, 7), referenced_message: { ...message(7), channel_id: '433456789012345678' } },
  ];
  const fetched: string[] = [];
  const context = await loadChannelContext('Rae', channelId, questionId, {
    recent: async () => raw,
    message: async target => {
      fetched.push(target);
      if (target === id(2)) throw new Error('404');
      if (target === id(3)) return message(55); // Different ID than requested.
      if (target === id(4)) return { ...message(4), channel_id: '433456789012345678' };
      return message(7);
    },
  });
  assert.deepEqual(fetched, [id(2), id(3), id(4), id(7)]);
  assert.deepEqual(context.referencedMessages?.map(value => value.id), [id(7)]);
  assert.equal(context.recentMessages.find(value => value.id === id(95))?.replyTo, undefined);
  assert.equal(context.recentMessages.find(value => value.id === id(96))?.replyTo, undefined);
  assert.equal(context.recentMessages.find(value => value.id === id(94))?.replyTo, undefined);
});

test('a reference deadline keeps collected context and aborts unfinished reads without starting further lookups', async () => {
  const fetched: string[] = [];
  let pendingSignal: AbortSignal | undefined;
  const context = await loadChannelContext('Rae', channelId, questionId, {
    recent: async () => [reply(100, 1), reply(99, 2), reply(98, 3), { ...reply(97, 4), referenced_message: message(4) }],
    message: async (target, signal) => {
      fetched.push(target);
      if (target === id(1)) return message(1);
      pendingSignal = signal;
      return new Promise<DiscordContextMessage>(() => {});
    },
  }, 25);
  assert.deepEqual(fetched, [id(1), id(2)]);
  assert.equal(pendingSignal?.aborted, true);
  assert.equal(context.recentMessages.length, 4);
  assert.deepEqual(context.referencedMessages?.map(value => value.id), [id(1), id(4)]);
});

test('unavailable or stalled recent history yields an empty optional context', async () => {
  for (const recent of [async () => { throw new Error('403'); }, async () => new Promise<DiscordContextMessage[]>(() => {})]) {
    const context = await loadChannelContext('Rae', channelId, questionId, {
      recent, message: async () => { throw new Error('Must not fetch a target without history'); },
    }, 25);
    assert.deepEqual(context, { questionAuthor: 'Rae', recentMessages: [] });
  }
});
