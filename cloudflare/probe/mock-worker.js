// Synthetic services for the local probe. This file is never deployed by Wrangler.
import { DurableObject } from 'cloudflare:workers';

export class MockServices extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS observations (kind TEXT, data TEXT)');
    this.socket = null;
    this.ack = true;
    this.mode = 'normal';
    this.sequence = 1;
  }

  record(kind, data) { this.sql.exec('INSERT INTO observations VALUES (?, ?)', kind, JSON.stringify(data)); }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.socket = server;
      server.accept();
      this.record('connection', { host: url.hostname });
      server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }));
      server.addEventListener('message', (event) => {
        const packet = JSON.parse(event.data);
        this.record('packet', packet);
        if (packet.op === 2) server.send(JSON.stringify({ op: 0, s: this.sequence++, t: 'READY',
          d: { session_id: 'synthetic-session', resume_gateway_url: 'wss://resume.probe.invalid' } }));
        if (packet.op === 6) server.send(JSON.stringify({ op: 0, s: this.sequence++, t: 'RESUMED', d: {} }));
        if (packet.op === 1 && this.ack) server.send(JSON.stringify({ op: 11, d: null }));
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/control') {
      const body = await request.json();
      if ('ack' in body) this.ack = body.ack;
      if ('mode' in body) this.mode = body.mode;
      if (body.packet) this.socket.send(JSON.stringify(body.packet));
      if (body.message) this.socket.send(JSON.stringify({ op: 0, s: this.sequence++, t: 'MESSAGE_CREATE', d: body.message }));
      if (body.close) this.socket.close(body.close, 'Synthetic close');
      return Response.json({ ok: true });
    }
    if (url.pathname === '/observations') {
      return Response.json([...this.sql.exec('SELECT kind, data FROM observations')].map(row => ({ kind: row.kind, data: JSON.parse(row.data) })));
    }
    if (url.pathname.endsWith('/chat/completions')) {
      const body = await request.json();
      this.record('model', { body, authorization: request.headers.get('Authorization') });
      if (this.mode === 'model-failure') return Response.json({ error: { message: 'synthetic upstream failure' } }, { status: 503 });
      if (this.mode === 'slow-model') await new Promise(resolve => setTimeout(resolve, 600));
      const last = body.messages.at(-1);
      const message = last.role === 'user' && /search/.test(last.content)
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'search-1', type: 'function',
          function: { name: 'web_search', arguments: JSON.stringify({ query: 'synthetic documentation' }) } }] }
        : { role: 'assistant', content: last.role === 'tool' ? 'A verified synthetic result [S1].' : 'A synthetic reply.' };
      return Response.json({ choices: [{ message, finish_reason: 'stop' }] });
    }
    if (url.pathname === '/tools/search') {
      this.record('search', { body: await request.json(), authorization: request.headers.get('Authorization') });
      return Response.json({ results: [{ url: 'https://example.com/source', title: 'Synthetic source', summary: 'Synthetic evidence.' }] });
    }
    if (/\/channels\/\d+\/messages$/.test(url.pathname)) {
      this.record('delivery', { body: await request.json() });
      return Response.json({ id: '923456789012345678' });
    }
    if (url.pathname.endsWith('/gateway/bot')) {
      return Response.json({ url: 'wss://gateway.probe.invalid', shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 86400000, max_concurrency: 1 } });
    }
    return new Response('Unexpected synthetic-service request', { status: 500 });
  }
}

export default {
  fetch(request, env) {
    const hostname = new URL(request.url).hostname;
    if (!hostname.endsWith('.probe.invalid')) return new Response('External network disabled', { status: 403 });
    return env.MOCK.getByName('synthetic').fetch(request);
  },
};
