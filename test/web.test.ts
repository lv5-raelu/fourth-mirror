import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DeepSeekWebProvider } from '../src/chat/web/deepseek.ts';
import { WebTurn } from '../src/chat/web/tools.ts';
import { publicWebUrl } from '../src/chat/web/types.ts';
import type { WebProvider } from '../src/chat/web/types.ts';
import { spoilerDelimiters, spoilerSpans } from '../src/chat/spoilers.ts';

const signal = (): AbortSignal => AbortSignal.timeout(5000);

async function serverFixture(t: TestContext, handle: RequestListener): Promise<string> {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return 'http://127.0.0.1:' + address.port + '/v1/tools';
}

test('web adapter uses its own key and endpoints, normalizes search, and bounds page content', async t => {
  const requests: { url: string | undefined; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const baseUrl = await serverFixture(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url?.endsWith('/search') ? { results: [
        { title: 'Official notice', url: 'https://example.com/news', summary: 'Banner announcement.', date: '2026-10-29' },
        { title: 'Private host', url: 'http://127.0.0.1/private', summary: 'Do not fetch.' },
      ] } : { title: 'Official notice', content: 'x'.repeat(12_000) }));
    });
  });
  const provider = new DeepSeekWebProvider({ apiKey: 'independent-web-key', baseUrl });
  const results = await provider.search('current announcements', signal());
  assert.equal(results.length, 1);
  assert.equal(results[0]?.publishedAt, '2026-10-29');
  const page = await provider.fetchPage(results[0]!.url, signal());
  assert.equal(page.content.length, 8000);
  assert.equal(requests[0]?.url, '/v1/tools/search');
  assert.equal(requests[1]?.url, '/v1/tools/fetch');
  assert.equal(requests[0]?.authorization, 'Bearer independent-web-key');
  assert.deepEqual(requests[0]?.body, { query: 'current announcements', count: 5, need_content: false });
  assert.deepEqual(requests[1]?.body, { url: 'https://example.com/news' });
});

test('private hosts, credentials, unsafe protocols, and unknown tools never reach a web backend', async () => {
  let calls = 0;
  const provider: WebProvider = {
    search: async () => { calls++; return []; },
    fetchPage: async () => { calls++; return { title: '', url: '', content: '' }; },
  };
  const turn = new WebTurn(provider);
  for (const url of ['http://localhost/', 'http://127.1/', 'http://2130706433/', 'http://[::1]/', 'https://user:secret@example.com', 'file:///etc/passwd', 'http://metadata.google.internal/', 'https://example.com:8080/']) {
    assert.throws(() => publicWebUrl(url));
    assert.match(await turn.run('web_fetch', JSON.stringify({ url }), signal()), /error/);
  }
  assert.match(await turn.run('read_file', '{"path":".env"}', signal()), /Unknown tool/);
  assert.match(await turn.run('web_search', '{bad json', signal()), /Invalid web tool arguments/);
  assert.match(await turn.run('web_search', '{"query":"  "}', signal()), /1 to 128/);
  assert.equal(calls, 0);
});

test('deduplicates lookups, shares source IDs between search and fetch, and renders only known markers', async () => {
  let calls = 0;
  const turn = new WebTurn({
    search: async () => { calls++; return [{ title: 'Official [notice]', url: 'https://example.com/news', summary: 'A new banner.', publishedAt: null }]; },
    fetchPage: async url => { calls++; return { title: 'Full notice', url, content: 'The announcement is confirmed.' }; },
  });
  const first = await turn.run('web_search', '{"query":"upcoming banners"}', signal());
  assert.equal(await turn.run('web_search', '{"query":"upcoming banners"}', signal()), first);
  const page = JSON.parse(await turn.run('web_fetch', '{"url":"https://example.com/news"}', signal())) as { source_id: string };
  assert.equal(page.source_id, 'S1');
  assert.equal(calls, 2);
  const answer = turn.renderCitations('Confirmed. [S1] Unverified marker [S999]');
  assert.match(answer, /https:\/\/example.com\/news/);
  assert.ok(!answer.includes('[S999]'));
  assert.ok(!answer.includes('[S1]'));
  const linkedMarker = turn.renderCitations('Confirmed. [S1](https://invented.example.com/fake)');
  assert.ok(!linkedMarker.includes('invented.example.com'));
  assert.equal((linkedMarker.match(/https:\/\/example.com\/news/g) || []).length, 1);
  assert.match(turn.renderCitations('Confirmed.'), /\(Source:/);
  assert.equal(turn.renderCitations('Confirmed. [S1]', false, false), 'Confirmed.');
  assert.equal(turn.renderCitations('Confirmed.', false, false), 'Confirmed.');
});

test('limits external calls and returned context, without offering citations for omitted page data', async () => {
  let calls = 0;
  const turn = new WebTurn({
    search: async () => { calls++; return []; },
    fetchPage: async url => { calls++; return { title: 'Page', url, content: 'x'.repeat(20_000) }; },
  });
  let characters = 0;
  for (let i = 0; i < 10; i++) characters += (await turn.run('web_fetch', JSON.stringify({ url: 'https://example.com/page' + i }), signal())).length;
  assert.ok(calls <= 6);
  assert.ok(characters < 26_000);
  const answer = turn.renderCitations('Check [S3].');
  assert.ok(!answer.includes('page2'));
});

test('spoiler replies hide revealing web source titles in citations and fallback references without nesting tags', async () => {
  const turn = new WebTurn({
    search: async () => [{ title: 'The captain || dies', url: 'https://example.com/ending||', summary: 'A synthetic ending.', publishedAt: null }],
    fetchPage: async () => { throw new Error('Not used'); },
  });
  await turn.run('web_search', '{"query":"fictional ending"}', signal());
  for (const text of ['||The captain dies. [S1]||', '||The captain dies.|| [S1]', '||The captain dies.||']) {
    const rendered = turn.renderCitations(text, true);
    assert.equal(spoilerDelimiters(rendered).length % 2, 0);
    const title = rendered.indexOf('The captain \\|\\| dies');
    assert.ok(title > 0);
    assert.ok(spoilerSpans(rendered).some(span => title >= span.start && title < span.end));
    assert.ok(rendered.includes('https://example.com/ending%7C%7C'));
  }
});

test('web failures and redirects do not expose secrets or forward credentials to another host', async t => {
  let calls = 0;
  const baseUrl = await serverFixture(t, (_req, res) => {
    calls++;
    res.writeHead(302, { Location: 'http://127.0.0.1:9/steal-key' });
    res.end('private-api-key and confidential response');
  });
  const turn = new WebTurn(new DeepSeekWebProvider({ apiKey: 'private-api-key', baseUrl }));
  const result = await turn.run('web_search', '{"query":"public question"}', signal());
  assert.match(result, /failed|unavailable/);
  assert.ok(!result.includes('private-api-key'));
  assert.ok(!result.includes('confidential'));
  assert.equal(calls, 1);
  assert.match(turn.renderCitations('I could not check.'), /No live sources were verified/);
});

test('rejects oversized or malformed web responses without exposing the response body', async t => {
  const baseUrl = await serverFixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ content: 'x'.repeat(1_000_001) }));
  });
  const provider = new DeepSeekWebProvider({ apiKey: 'unused-key', baseUrl });
  await assert.rejects(provider.fetchPage('https://example.com/', signal()), /too large/);
});
