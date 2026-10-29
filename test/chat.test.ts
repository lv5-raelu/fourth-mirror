import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ChatService } from '../src/chat/service.ts';
import { ChatStore } from '../src/chat/store.ts';
import type { ChatMessage, ChatProvider } from '../src/chat/types.ts';

const owner = '123456789012345678';
const thread = '223456789012345678';
const otherOwner = '323456789012345678';
const otherThread = '423456789012345678';
const discard = async (): Promise<void> => {};

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function fixture(t: TestContext, provider: ChatProvider) {
  const directory = await mkdtemp(join(tmpdir(), 'fourth-mirror-chat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'chats.json');
  const store = await ChatStore.open(file);
  let now = 100_000;
  const service = new ChatService(provider, store, () => now);
  return { file, store, service, advance: () => { now += 30_001; } };
}

test('keeps conversations isolated and continues portable history after a provider switch and restart', async (t) => {
  const calls: (readonly ChatMessage[])[] = [];
  const { file, service, advance } = await fixture(t, { reply: async (messages) => { calls.push(messages); return 'First reply'; } });
  await service.create(owner, async () => thread);
  await service.create(otherOwner, async () => otherThread);
  await service.reply(thread, owner, 'Remember my name is Rae.', discard);
  await service.reply(otherThread, otherOwner, 'A separate conversation', discard);
  assert.deepEqual(calls[1], [{ role: 'user', content: 'A separate conversation' }]);

  const restored = new ChatService({ reply: async (messages) => { calls.push(messages); return 'Rae'; } }, await ChatStore.open(file));
  await restored.reply(thread, owner, 'What is my name?', discard);
  assert.deepEqual(calls[2], [
    { role: 'user', content: 'Remember my name is Rae.' },
    { role: 'assistant', content: 'First reply' },
    { role: 'user', content: 'What is my name?' },
  ]);
  advance();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('rejects other users, resets only the owned thread, and sends fresh context afterward', async (t) => {
  const calls: (readonly ChatMessage[])[] = [];
  const { service, advance } = await fixture(t, { reply: async (messages) => { calls.push(messages); return 'Reply'; } });
  await service.create(owner, async () => thread);
  await service.reply(thread, owner, 'Old context', discard);
  await assert.rejects(service.reply(thread, otherOwner, 'Access someone else’s history', discard), /Only the person/);
  await assert.rejects(service.reset(thread, otherOwner), /Only the person/);
  await service.reset(thread, owner);
  advance();
  await service.reply(thread, owner, 'Fresh question', discard);
  assert.deepEqual(calls[1], [{ role: 'user', content: 'Fresh question' }]);
});

test('rejects overlapping replies and resets, then releases locks when the provider fails', async (t) => {
  const pending = deferred();
  const { service, advance } = await fixture(t, { reply: () => pending.promise });
  await service.create(owner, async () => thread);
  const first = service.reply(thread, owner, 'Pending', discard);
  await assert.rejects(service.reply(thread, owner, 'Overlap', discard), /previous message/);
  await assert.rejects(service.reset(thread, owner), /current reply/);
  pending.reject(new Error('Provider failed'));
  await assert.rejects(first, /Provider failed/);
  assert.deepEqual(service.getSession(thread)?.history, []);
  advance();
  await service.reset(thread, owner);
});

test('delivery failures do not append unseen turns; cooldown and prompt limits prevent API calls', async (t) => {
  let calls = 0;
  const { service, advance } = await fixture(t, { reply: async () => { calls++; return 'Reply'; } });
  await service.create(owner, async () => thread);
  await assert.rejects(service.reply(thread, owner, 'Hello', async () => { throw new Error('Discord unavailable'); }), /Discord unavailable/);
  assert.deepEqual(service.getSession(thread)?.history, []);
  await assert.rejects(service.reply(thread, owner, 'Too soon', discard), /few seconds/);
  advance();
  await assert.rejects(service.reply(thread, owner, 'x'.repeat(4_001), discard), /4,000/);
  await assert.rejects(service.reply(thread, owner, '  ', discard), /text message/);
  assert.equal(calls, 1);
  await service.reply(thread, owner, 'Retry', discard);
  assert.equal(calls, 2);
});

test('bounds context by complete exchanges instead of growing the request indefinitely', async (t) => {
  let lastInput: readonly ChatMessage[] = [];
  const { service, advance } = await fixture(t, { reply: async (messages) => { lastInput = messages; return 'y'.repeat(1_000); } });
  await service.create(owner, async () => thread);
  for (let index = 0; index < 15; index++) {
    await service.reply(thread, owner, `${index} ${'x'.repeat(2_000)}`, discard);
    advance();
  }
  assert.equal(lastInput[0]?.role, 'user');
  assert.ok(lastInput.reduce((total, message) => total + message.content.length, 0) <= 24_000);
  const history = service.getSession(thread)!.history;
  assert.ok(history.length <= 20);
  assert.ok(history.reduce((total, message) => total + message.content.length, 0) <= 24_000);
  assert.equal(history[0]?.role, 'user');
  assert.equal(history.at(-1)?.role, 'assistant');
  assert.ok(!history.some((message) => message.content.startsWith('0 ')));
});

test('parallel writes preserve both sessions and invalid saved history is never overwritten', async (t) => {
  const { store, file } = await fixture(t, { reply: async () => 'unused' });
  await Promise.all([
    store.put({ threadId: thread, ownerId: owner, history: [], updatedAt: 1 }),
    store.put({ threadId: otherThread, ownerId: otherOwner, history: [], updatedAt: 2 }),
  ]);
  const loaded = await ChatStore.open(file);
  assert.equal(loaded.get(thread)?.ownerId, owner);
  assert.equal(loaded.get(otherThread)?.ownerId, otherOwner);
  const invalid = '{"version":1,"sessions":[{"bad":"data"}]}';
  await writeFile(file, invalid);
  await assert.rejects(ChatStore.open(file), /invalid chat history/);
  assert.equal(await readFile(file, 'utf8'), invalid);
});

test('oversized model output stays within the delivery limit without splitting an emoji', async (t) => {
  const { service, file } = await fixture(t, { reply: async () => '🙂'.repeat(10_000) });
  await service.create(owner, async () => thread);
  let delivered = '';
  await service.reply(thread, owner, 'Hello', async (text) => { delivered = text; });
  assert.ok(delivered.length <= 16_000);
  assert.ok(!/[\uD800-\uDFFF]/u.test(delivered));
  assert.match(delivered, /Reply shortened/);
  assert.equal((await ChatStore.open(file)).get(thread)?.history.at(-1)?.content, delivered);
});

test('limits concurrent provider calls across users and prevents duplicate thread creation', async (t) => {
  const pending = deferred();
  const { service } = await fixture(t, { reply: () => pending.promise });
  const owners = [owner, otherOwner, '523456789012345678', '623456789012345678'];
  const threads = [thread, otherThread, '723456789012345678', '823456789012345678'];
  for (let i = 0; i < owners.length; i++) await service.create(owners[i]!, async () => threads[i]!);
  const active = owners.slice(0, 3).map((userId, i) => service.reply(threads[i]!, userId, 'Hello', discard));
  await assert.rejects(service.reply(threads[3]!, owners[3]!, 'Hello', discard), /slots are busy/);
  let created = false;
  await assert.rejects(service.create(owner, async () => { created = true; return '923456789012345678'; }), /30 seconds/);
  assert.equal(created, false);
  pending.resolve('Done');
  await Promise.all(active);
});
