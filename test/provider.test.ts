import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { OpenAICompatibleProvider } from '../src/chat/provider.ts';
import type { AiConfig } from '../src/config.ts';

async function mockServer(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/custom/v1`;
}

function settings(baseUrl: string, overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    apiKey: 'test-provider-key', baseUrl, model: 'arbitrary-model', systemPrompt: 'Answer clearly.',
    maxOutputTokens: 512, tokenLimitParam: 'max_completion_tokens', historyFile: 'unused.json', ...overrides,
  };
}

test('sends the configured endpoint, key, model, history, and token-limit field over HTTP', async (t) => {
  const received: { path: string | undefined; auth: string | undefined; body: Record<string, unknown> }[] = [];
  const baseUrl = await mockServer(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }] }));
    });
  });
  const history = [{ role: 'user' as const, content: 'Hi' }, { role: 'assistant' as const, content: 'Previous reply' }, { role: 'user' as const, content: 'Continue' }];
  assert.equal(await new OpenAICompatibleProvider(settings(baseUrl)).reply(history), 'Hello!');
  assert.equal(await new OpenAICompatibleProvider(settings(baseUrl, { apiKey: 'rotated-key', model: 'another/model', tokenLimitParam: 'max_tokens' })).reply(history), 'Hello!');
  assert.equal(received[0]?.path, '/custom/v1/chat/completions');
  assert.equal(received[0]?.auth, 'Bearer test-provider-key');
  assert.deepEqual(received[0]?.body, {
    model: 'arbitrary-model', messages: [{ role: 'system', content: 'Answer clearly.' }, ...history], max_completion_tokens: 512,
  });
  assert.equal(received[1]?.auth, 'Bearer rotated-key');
  assert.equal(received[1]?.body.model, 'another/model');
  assert.equal(received[1]?.body.max_tokens, 512);
  assert.ok(!('max_completion_tokens' in received[1]!.body));
});

test('provider failures do not leak secrets or prompts, and are not automatically retried', async (t) => {
  let calls = 0;
  const baseUrl = await mockServer(t, (_req, res) => {
    calls++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Rejected secret-key with private prompt contents' } }));
  });
  await assert.rejects(new OpenAICompatibleProvider(settings(baseUrl)).reply([{ role: 'user', content: 'private prompt contents' }]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /owner needs to check/);
    assert.ok(!error.message.includes('secret-key'));
    assert.ok(!error.message.includes('private prompt'));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test('empty model responses fail clearly instead of saving a blank assistant turn', async (t) => {
  const baseUrl = await mockServer(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'length' }] }));
  });
  await assert.rejects(new OpenAICompatibleProvider(settings(baseUrl)).reply([{ role: 'user', content: 'Hello' }]), /returned no text/);
});
