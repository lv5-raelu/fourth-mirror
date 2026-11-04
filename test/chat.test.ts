import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ChatService } from '../src/chat/service.ts';
import { ChatStore } from '../src/chat/store.ts';
import type { ChatContext, ChatMessage, ChatProvider } from '../src/chat/types.ts';
import { parseHistory } from '../src/chat/history.ts';

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

test('reply truncation closes a story spoiler before its length notice and persists the delivered form', async t => {
  const { service, file } = await fixture(t, { reply: async () => 'An introduction. ||' + 'secret🙂'.repeat(3_000) + '||' });
  await service.create(owner, async () => thread);
  let delivered = '';
  await service.reply(thread, owner, 'Explain the ending', async text => { delivered = text; });
  assert.ok(delivered.length <= 16_000);
  assert.ok(delivered.endsWith('||\n\n*Reply shortened.*'));
  assert.ok(!/[\uD800-\uDFFF]/u.test(delivered));
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

test('group turns run in order with fresh shared context and stable speaker identities', async t => {
  const first = deferred();
  const started = deferred();
  const calls: (readonly ChatMessage[])[] = [];
  const { service, file } = await fixture(t, { reply: async messages => {
    calls.push(messages);
    if (calls.length === 1) { started.resolve('started'); return first.promise; }
    return 'Second answer';
  } });
  await service.create(owner, async () => thread, 'group');
  const delivered: string[] = [];
  const one = service.reply(thread, owner, 'My question', async text => { delivered.push(text); }, { speakerName: 'Rae' });
  await started.promise;
  const two = service.reply(thread, otherOwner, 'My follow-up', async text => { delivered.push(text); }, { speakerName: 'Rae' });
  await assert.rejects(service.reply(thread, otherOwner, 'Duplicate pending question', discard), /previous message/);
  await assert.rejects(service.reset(thread, owner), /queued messages/);
  await assert.rejects(service.reset(thread, otherOwner), /Only the person/);
  assert.equal(calls.length, 1);
  first.resolve('First answer');
  await Promise.all([one, two]);
  assert.deepEqual(delivered, ['First answer', 'Second answer']);
  assert.deepEqual(calls[1], [
    { role: 'user', content: 'My question', speaker: { id: owner, name: 'Rae' } },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: 'My follow-up', speaker: { id: otherOwner, name: 'Rae' } },
  ]);
  const restored = (await ChatStore.open(file)).get(thread)!;
  assert.equal(restored.mode, 'group');
  assert.deepEqual(parseHistory({ version: 1, sessions: [restored] }).sessions[0], restored);
  await service.reset(thread, owner);
  assert.equal(service.getSession(thread)?.mode, 'group');
  assert.deepEqual(service.getSession(thread)?.history, []);
});

test('group queues are bounded and continue after a failed turn without saving failed context', async t => {
  const first = deferred();
  const started = deferred();
  const calls: (readonly ChatMessage[])[] = [];
  const { service } = await fixture(t, { reply: async messages => {
    calls.push(messages);
    if (calls.length === 1) { started.resolve('started'); return first.promise; }
    return 'Recovered';
  } });
  await service.create(owner, async () => thread, 'group');
  const rejected = assert.rejects(service.reply(thread, owner, 'This will fail', discard), /provider failed/);
  await started.promise;
  const pending = [otherOwner, '523456789012345678', '623456789012345678'].map(userId => service.reply(thread, userId, 'Next question', discard));
  await assert.rejects(service.reply(thread, '723456789012345678', 'Queue overflow', discard), /queue is full/);
  first.reject(new Error('provider failed'));
  await rejected;
  await Promise.all(pending);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1], [{ role: 'user', content: 'Next question', speaker: { id: otherOwner, name: 'User' } }]);
  assert.ok(!service.getSession(thread)!.history.some(message => message.content === 'This will fail'));
});

test('restart lets paid group work finish, cancels waiting questions, and can resume without replaying them', async t => {
  const first = deferred();
  const started = deferred();
  let calls = 0;
  const { service, advance } = await fixture(t, { reply: async () => {
    calls++;
    if (calls === 1) { started.resolve('started'); return first.promise; }
    return 'New answer';
  } });
  await service.create(owner, async () => thread, 'group');
  const active = service.reply(thread, owner, 'Active question', discard);
  await started.promise;
  const waiting = assert.rejects(service.reply(thread, otherOwner, 'Queued question', discard), /restarting/);
  service.cancelQueuedReplies();
  await assert.rejects(service.reply(thread, '523456789012345678', 'Arrived during drain', discard), /restarting/);
  first.resolve('Finished active turn');
  await Promise.all([active, waiting]);
  assert.equal(calls, 1);
  service.resumeReplies(); advance();
  await service.reply(thread, otherOwner, 'Resent question', discard);
  assert.equal(calls, 2);
  assert.ok(!service.getSession(thread)!.history.some(message => message.content === 'Queued question'));
});

test('waiting groups respect the global three-request limit and cancel without consuming a slot', async t => {
  const gate = deferred();
  let calls = 0;
  const { service } = await fixture(t, { reply: async () => { calls++; return gate.promise; } });
  const users = [owner, otherOwner, '523456789012345678'];
  const threads = [thread, otherThread, '623456789012345678'];
  for (let i = 0; i < users.length; i++) await service.create(users[i]!, async () => threads[i]!);
  await service.create('723456789012345678', async () => '823456789012345678', 'group');
  const active = users.map((userId, i) => service.reply(threads[i]!, userId, 'Personal question', discard));
  await Promise.resolve();
  const waiting = assert.rejects(service.reply('823456789012345678', '723456789012345678', 'Wait for a slot', discard), /restarting/);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 3);
  service.cancelQueuedReplies();
  gate.resolve('Done');
  await Promise.all([...active, waiting]);
  assert.equal(calls, 3);
});

test('history parsing keeps old personal sessions private and rejects invalid group metadata', () => {
  const legacy = { threadId: thread, ownerId: owner, history: [], updatedAt: 1 };
  assert.deepEqual(parseHistory({ version: 1, sessions: [legacy] }).sessions[0], legacy);
  for (const session of [
    { ...legacy, mode: 'public' },
    { ...legacy, history: [{ role: 'user', content: 'Question', speaker: { id: owner, name: 'Rae' } }, { role: 'assistant', content: 'Answer' }] },
    { ...legacy, mode: 'group', history: [{ role: 'user', content: 'Question', speaker: { id: 'invalid', name: 'Rae' } }, { role: 'assistant', content: 'Answer' }] },
  ]) assert.throws(() => parseHistory({ version: 1, sessions: [session] }), /Invalid chat history/);
});

test('one-off answers use fresh inputs and optional channel context without accessing saved conversations', async () => {
  const calls: { messages: readonly ChatMessage[]; context?: ChatContext }[] = [];
  let now = 100_000;
  const service = new ChatService({ reply: async (messages, context) => { calls.push({ messages, ...(context ? { context } : {}) }); return 'Answer'; } }, {
    get: () => { throw new Error('One-off answers must not read a session.'); },
    put: async () => { throw new Error('One-off answers must not save a session.'); },
  }, () => now);
  const context = { questionAuthor: 'Rae', recentMessages: [{ author: 'Alex', content: 'We were discussing coffee.' }] };
  await service.answer(owner, 'What does Alex mean?', discard, { context: async () => context });
  now += 5_001;
  await service.answer(owner, 'An unrelated question', discard, { context: async () => { throw new Error('Read denied'); } });
  assert.deepEqual(calls, [
    { messages: [{ role: 'user', content: 'What does Alex mean?' }], context },
    { messages: [{ role: 'user', content: 'An unrelated question' }] },
  ]);
});

test('one-off answers share cooldowns, busy users, global slots, and restart admission with chats', async t => {
  const gate = deferred();
  const allStarted = deferred();
  let calls = 0;
  const { service, advance } = await fixture(t, { reply: () => { if (++calls === 3) allStarted.resolve('started'); return gate.promise; } });
  await service.create(owner, async () => thread);
  let reads = 0;
  const context = async () => { reads++; return { questionAuthor: 'Rae', recentMessages: [] }; };
  const active = service.answer(owner, 'First question', discard, { context });
  await assert.rejects(service.reply(thread, owner, 'Overlap', discard), /previous message/);
  await assert.rejects(service.answer(owner, 'Overlap', discard, { context }), /previous message/);
  const others = [otherOwner, '523456789012345678'].map(user => service.answer(user, 'Another question', discard));
  await assert.rejects(service.answer('623456789012345678', 'Over capacity', discard, { context }), /slots are busy/);
  await allStarted.promise;
  service.cancelQueuedReplies();
  await assert.rejects(service.answer('723456789012345678', 'During drain', discard, { context }), /restarting/);
  gate.resolve('Finished');
  await Promise.all([active, ...others]);
  assert.equal(reads, 1);
  service.resumeReplies();
  await assert.rejects(service.answer(owner, 'Too soon', discard), /few seconds/);
  advance();
  await service.reply(thread, owner, 'Fresh chat question', discard);
});

test('failed one-off work releases admission and rejects invalid prompts before reading channel context', async t => {
  let calls = 0, reads = 0;
  const { service, advance } = await fixture(t, { reply: async () => { calls++; if (calls === 1) throw new Error('Provider failed'); return 'Answer'; } });
  const context = async () => { reads++; return { questionAuthor: 'Rae', recentMessages: [] }; };
  await assert.rejects(service.answer(owner, ' ', discard, { context }), /text message/);
  await assert.rejects(service.answer(owner, 'x'.repeat(4_001), discard, { context }), /4,000/);
  assert.equal(reads, 0);
  await assert.rejects(service.answer(owner, 'Question', discard), /Provider failed/);
  advance();
  await assert.rejects(service.answer(owner, 'Try again', async () => { throw new Error('Delivery failed'); }), /Delivery failed/);
  advance();
  await service.answer(owner, 'Recovered', discard);
  assert.equal(calls, 3);
});

test('a restart during context loading cancels a one-off before starting a paid model request', async t => {
  let calls = 0;
  const { service } = await fixture(t, { reply: async () => { calls++; return 'Answer'; } });
  const loading = deferred(), release = deferred();
  const rejected = assert.rejects(service.answer(owner, 'Question', discard, { context: async () => {
    loading.resolve('loading'); await release.promise;
    return { questionAuthor: 'Rae', recentMessages: [] };
  } }), /restarting/);
  await loading.promise;
  service.cancelQueuedReplies();
  release.resolve('loaded');
  await rejected;
  assert.equal(calls, 0);
});

test('a dedicated source query fails before a paid request if its source is unavailable', async t => {
  let calls = 0;
  const { service } = await fixture(t, { reply: async () => { calls++; return 'Must not guess'; } });
  await assert.rejects(service.answer(owner, 'What changed in beta?', discard, { source: async () => { throw new Error('Source unavailable'); } }), /Source unavailable/);
  assert.equal(calls, 0);
});
