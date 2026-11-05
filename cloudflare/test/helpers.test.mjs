import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { DiscordRest, DiscordError } from '../src/rest.ts';
import { envValue } from '../scripts/env.mjs';
import { parseHistory } from '../../src/chat/history.ts';
import { performUpdate } from '../scripts/update-flow.mjs';
import { missedSamplingWindow } from '../scripts/monitoring.mjs';
import { upgradeWebSocket } from '../src/websocket.ts';

test('secret preparation round-trips quotes and multiline settings without interpreting them', () => {
  for (const value of ['a', 'hello "world"', "single' quote", "single' double\"", 'line\nnext', 'literal\\ntext', '`code` and "quotes"', '$() `no shell`']) {
    assert.equal(parseEnv('VALUE=' + envValue('VALUE', value)).VALUE, value);
  }
});

test('monitor accepts the planned quiet period but rejects laptop sleep gaps and a backwards clock', () => {
  assert.equal(missedSamplingWindow(undefined, 0, 0), false);
  assert.equal(missedSamplingWindow(0, 960_000, 960_000), false);
  assert.equal(missedSamplingWindow(960_000, 1_020_000, 60_000), false);
  assert.equal(missedSamplingWindow(960_000, 4_560_000, 60_000), true);
  assert.equal(missedSamplingWindow(960_000, 900_000, 60_000), true);
});

test('WebSocket handshake deadline does not abort an already upgraded connection', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let signal;
  globalThis.fetch = async (_url, options) => { signal = options.signal; return new Response(); };
  await upgradeWebSocket('https://gateway.probe.invalid', 10);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(signal.aborted, false);
});

test('WebSocket handshake deadline still aborts a stalled upgrade', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  await assert.rejects(upgradeWebSocket('https://gateway.probe.invalid', 10), /handshake timed out/);
});

test('history import rejects duplicates and oversized context and strips unknown fields', () => {
  const session = { threadId: '223456789012345678', ownerId: '423456789012345678', updatedAt: 1, history: [], extra: 'not imported' };
  assert.throws(() => parseHistory({ version: 1, sessions: [session, session] }), /Duplicate/);
  assert.throws(() => parseHistory({ version: 1, sessions: [{ ...session, history: [{ role: 'user', content: 'x'.repeat(24_000) }, { role: 'assistant', content: 'overflow' }] }] }), /Invalid/);
  assert.ok(!('extra' in parseHistory({ version: 1, sessions: [session] }).sessions[0]));
});

test('Discord transport rejects redirects and server failures without retrying ambiguous mutations', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++; assert.equal(options.redirect, 'manual');
    return new Response('private upstream body', { status: 503 });
  };
  const rest = new DiscordRest('synthetic-secret');
  await assert.rejects(rest.message('223456789012345678', 'hello', 'nonce'), error => error instanceof DiscordError && error.status === 503 && !error.message.includes('private'));
  assert.equal(calls, 1);
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://example.com' } }); };
  await assert.rejects(rest.request('POST', '/test', {}), error => error.status === 302);
  assert.equal(calls, 2);
});

test('Discord transport uploads image bytes as multipart data and clears previous images on a text edit', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (_url, options) => { calls.push(options); return Response.json({ id: '223456789012345678' }); };
  const rest = new DiscordRest('synthetic-token');
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await rest.editInteraction('123456789012345678', 'synthetic-interaction', {
    embeds: [{ title: 'Comparison', color: 1, footer: { text: 'Beta' }, image: { url: 'attachment://beta-diff.png' } }],
    files: [{ name: 'beta-diff.png', data: bytes, description: '100% → 120%' }],
  });
  const form = calls[0].body;
  assert.ok(form instanceof FormData);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].headers['Content-Type'], undefined, 'Fetch supplies the multipart boundary');
  const payload = JSON.parse(form.get('payload_json'));
  assert.ok(!('files' in payload)); assert.equal(payload.attachments[0].description, '100% → 120%');
  assert.deepEqual(new Uint8Array(await form.get('files[0]').arrayBuffer()), bytes);
  await rest.editInteraction('123456789012345678', 'synthetic-interaction', { embeds: [] });
  assert.deepEqual(JSON.parse(calls[1].body).attachments, []);
});

test('Discord route headers delay shared buckets and retry-after delays an explicitly rejected call', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return Response.json({ retry_after: 0.02, global: true }, { status: 429 });
    return Response.json({ ok: true }, { headers: { 'X-RateLimit-Bucket': 'shared', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '0.03' } });
  };
  const rest = new DiscordRest('synthetic-secret');
  const start = Date.now(); await rest.request('POST', '/test', {});
  assert.ok(Date.now() - start >= 60);
  const again = Date.now(); await rest.request('POST', '/test', {});
  assert.ok(Date.now() - again >= 65);
  assert.equal(calls, 3);
});

test('queued Discord requests retain their original deadline', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let release; let calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async () => { calls++; await held; return Response.json({ ok: true }); };
  const rest = new DiscordRest('synthetic-secret');
  const first = rest.request('GET', '/first');
  const expired = rest.request('POST', '/second', {}, { deadlineMs: 5 });
  const assertion = assert.rejects(expired, error => error.status === 408);
  await new Promise(resolve => setTimeout(resolve, 20)); release();
  await first; await assertion;
  assert.equal(calls, 1);
});

test('cancelling context reads aborts active requests and prevents cancelled queued requests from reaching Discord', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let started; let calls = 0;
  const active = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (_url, options) => {
    calls++; started();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  const rest = new DiscordRest('synthetic-secret');
  const controller = new AbortController();
  const first = rest.request('GET', '/channels/223456789012345678/messages', undefined, { signal: controller.signal });
  const rejected = assert.rejects(first);
  await active;
  const queued = rest.request('GET', '/channels/223456789012345678/messages/123456789012345678', undefined, { signal: controller.signal });
  const cancelled = assert.rejects(queued, error => error instanceof DiscordError && error.status === 408);
  controller.abort();
  await Promise.all([rejected, cancelled]);
  assert.equal(calls, 1);
});

function updateFixture(overrides = {}) {
  const order = [];
  const dependencies = {
    check: async () => { order.push('check'); }, access: async () => { order.push('access'); },
    control: async path => { order.push(path); return {}; },
    backup: async () => { order.push('backup'); }, deploy: async () => { order.push('deploy'); },
    wait: async () => { order.push('wait'); return { ready: true }; },
    ...overrides,
  };
  return { order, dependencies };
}

test('update verifies access before drain and saves backup before deployment', async () => {
  const { order, dependencies } = updateFixture();
  await performUpdate(dependencies);
  assert.deepEqual(order, ['check', 'access', '/status', '/drain', 'wait', '/history', 'backup', 'deploy', '/start', 'wait']);
});

test('failed checks never touch the hosted bot', async () => {
  const { order, dependencies } = updateFixture({ check: async () => { throw new Error('check failed'); } });
  await assert.rejects(performUpdate(dependencies), /check failed/);
  assert.deepEqual(order, []);
});

test('deployment failure requests restart of the existing bot', async () => {
  const { order, dependencies } = updateFixture({ deploy: async () => { throw new Error('deploy failed'); } });
  await assert.rejects(performUpdate(dependencies), /deploy failed/);
  assert.equal(order.at(-1), '/start');
  assert.equal(order.filter(item => item === '/start').length, 1);
});

test('a failed backup prevents deployment and restarts the existing bot', async () => {
  const { order, dependencies } = updateFixture({ backup: async () => { throw new Error('backup failed'); } });
  await assert.rejects(performUpdate(dependencies), /backup failed/);
  assert.ok(!order.includes('deploy'));
  assert.equal(order.at(-1), '/start');
});

test('a lost drain response still attempts recovery; a failed new deployment health check does not restart repeatedly', async () => {
  let starts = 0;
  const first = updateFixture({ control: async path => {
    if (path === '/drain') throw new Error('lost response');
    if (path === '/start') starts++;
    return {};
  } });
  await assert.rejects(performUpdate(first.dependencies), /lost response/); assert.equal(starts, 1);
  let waits = 0;
  const second = updateFixture({ wait: async () => { if (++waits === 2) throw new Error('blocked'); return {}; } });
  await assert.rejects(performUpdate(second.dependencies), /blocked/);
  assert.equal(second.order.filter(item => item === '/start').length, 1);
});
