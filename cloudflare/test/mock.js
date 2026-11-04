import { DurableObject } from 'cloudflare:workers';

function sourcePage(value) {
  const data = [];
  function encode(value) {
    if (value === undefined) return -1;
    const index = data.length; data.push(null);
    data[index] = Array.isArray(value) ? value.map(encode) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) : value;
    return index;
  }
  encode({ data: value });
  return JSON.stringify({ type: 'data', nodes: [{ type: 'data', data }] });
}

export class MockDiscord extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS observations (kind TEXT, data TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, type INTEGER, guild_id TEXT)');
    this.sql.exec("INSERT OR IGNORE INTO channels VALUES ('333456789012345678', 0, '323456789012345678'), ('223456789012345678', 12, '323456789012345678')");
    this.mode = 'normal';
    this.ack = true;
    this.sequence = 1;
    this.socket = null;
    this.rateLimited = new Set();
    this.nonces = new Set();
    this.contextMessages = null;
    this.contextTargets = {};
    this.betaRevision = 100;
    this.betaEmbedLinks = true;
  }
  record(kind, data) { this.sql.exec('INSERT INTO observations VALUES (?, ?)', kind, JSON.stringify(data)); }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v10/, '');
    if (['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
      this.record('media', { path, authorization: request.headers.get('Authorization') });
      if (path.endsWith('.json')) return Response.json({ v: '5.5.7', w: 32, h: 32, ip: 0, op: 20, fr: 10, layers: [{
        ty: 1, ind: 1, ip: 0, op: 20, sw: 8, sh: 8, sc: '#ff0000', ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 },
          a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, p: { a: 0, k: [8, 8, 0] } },
      }] });
      const fixture = path.endsWith('.gif')
        ? 'R0lGODlhAgABAIEAAP8AAAD/AAAA/wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQECgAAACwAAAAAAgABAAACAgQKACH5BAwKAAAALAAAAAABAAEAAAICTAEAIfkECAoAAAAsAQAAAAEAAQAAAgJUAQAh+QQECgAAACwAAAAAAQABAAACAkwBADs='
        : path.startsWith('/stickers/')
          ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAADAAAAAM7tusAAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAGQD6AAAs35jzQAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAaZmNUTAAAAAEAAAABAAAAAQAAAAAAAAAAAGQD6AAAKA2JGQAAABFmZEFUAAAAAnicY2D4z/AfAAQBAf9i5+mcAAAAGmZjVEwAAAADAAAAAQAAAAEAAAAAAAAAAABkA+gAAMWbWvAAAAARZmRBVAAAAAR4nGNgYPj/HwADAgH/DbnuYQAAAABJRU5ErkJggg=='
          : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
      return new Response(Uint8Array.from(atob(fixture), char => char.charCodeAt(0)));
    }
    if (url.hostname === 'hsr.gachabase.net') {
      this.record('beta-source', { path, authorization: request.headers.get('Authorization') });
      if (this.mode === 'beta-outage') return new Response('Unavailable', { status: 503 });
      if (path === '/changelog/beta/__data.json') return new Response(sourcePage({ revisions: [{
        revision: { branch: 'beta', version: '9.0.51', design_revision: this.betaRevision, resource_revision: 80 },
        characters: [{ id: 1, name: { text: 'Test Mirror' }, status: 'updated', href: '/characters/1/test-mirror/beta',
          diff: `/diff/characters/1/test-mirror?prev=beta_9.0.51_99&cur=beta_9.0.51_${this.betaRevision}` }],
      }] }));
      if (path === '/diff/characters/1/test-mirror/__data.json') return new Response(sourcePage({
        source: { dto: { skill: { name: { text: 'Beam' }, power: 20 } } }, target: { dto: { skill: { name: { text: 'Beam' }, power: 30 } } },
      }));
      this.record('unexpected', { host: url.hostname, path, method: request.method });
      return new Response('Unexpected beta route', { status: 404 });
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      this.socket = server;
      server.accept();
      this.record('connection', { host: url.hostname });
      server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }));
      server.addEventListener('message', event => {
        const packet = JSON.parse(event.data);
        this.record('packet', { ...packet, at: Date.now() });
        if (packet.op === 2) server.send(JSON.stringify({ op: 0, s: this.sequence++, t: 'READY', d: {
          session_id: 'synthetic-session', resume_gateway_url: 'wss://resume.discord.gg',
          user: { id: '999456789012345678', bot: true }, application: { id: '123456789012345678' },
        } }));
        if (packet.op === 6) server.send(JSON.stringify({ op: 0, s: this.sequence++, t: 'RESUMED', d: {} }));
        if (packet.op === 1 && this.ack) server.send(JSON.stringify({ op: 11, d: null }));
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === '/control') {
      const body = await request.json();
      if ('mode' in body) this.mode = body.mode;
      if ('ack' in body) this.ack = body.ack;
      if ('contextMessages' in body) this.contextMessages = body.contextMessages;
      if ('contextTargets' in body) this.contextTargets = body.contextTargets;
      if ('betaRevision' in body) this.betaRevision = body.betaRevision;
      if ('betaEmbedLinks' in body) this.betaEmbedLinks = body.betaEmbedLinks;
      if (body.channel) this.sql.exec('INSERT OR REPLACE INTO channels VALUES (?, ?, ?)', body.channel.id, body.channel.type, body.channel.guild_id ?? '323456789012345678');
      if (body.packet) this.socket.send(JSON.stringify(body.packet));
      if (body.event) this.socket.send(JSON.stringify({ op: 0, s: this.sequence++, t: body.event.t, d: body.event.d }));
      if (body.close) this.socket.close(body.close, 'Synthetic close');
      return Response.json({ ok: true });
    }
    if (path === '/observations') return Response.json([...this.sql.exec('SELECT kind, data FROM observations')].map(row => ({ kind: row.kind, data: JSON.parse(row.data) })));
    if (path === '/gateway/bot') {
      this.record('gateway-info', {});
      return Response.json({ url: 'wss://gateway.discord.gg', shards: 1,
        session_start_limit: { remaining: this.mode === 'quota' ? 0 : 1000, reset_after: 86400_000 } });
    }
    if (path === '/gateway') return Response.json({ url: 'wss://gateway.discord.gg' });
    if (/^\/guilds\/\d+\/roles$/.test(path)) return Response.json([{ id: path.split('/')[2], permissions: String(1024n | 2048n | (this.betaEmbedLinks ? 16384n : 0n)) }]);
    if (/^\/guilds\/\d+\/members\/\d+$/.test(path)) return Response.json({ roles: [] });
    if (/^\/channels\/\d+$/.test(path) && request.method === 'GET') {
      const id = path.split('/')[2];
      const channel = [...this.sql.exec('SELECT type, guild_id FROM channels WHERE id = ?', id)][0];
      return channel ? Response.json({ id, ...channel }) : Response.json({}, { status: 404 });
    }
    if (path.endsWith('/threads') && request.method === 'POST') {
      const body = await request.json();
      const count = [...this.sql.exec('SELECT COUNT(*) AS n FROM channels')][0].n;
      const id = String(233456789012345678n + BigInt(count));
      const parent = [...this.sql.exec('SELECT guild_id FROM channels WHERE id = ?', path.split('/')[2])][0];
      this.sql.exec('INSERT INTO channels VALUES (?, ?, ?)', id, body.type, parent.guild_id);
      this.record('thread', { id, body, guild_id: parent.guild_id });
      return Response.json({ id, type: body.type, guild_id: parent.guild_id });
    }
    if (path.includes('/thread-members/') && request.method === 'PUT') {
      this.record('member', { path });
      if (this.mode === 'invite-slow') await new Promise(resolve => setTimeout(resolve, 600));
      return new Response(null, { status: this.mode === 'invite-fail' ? 403 : 204 });
    }
    if (/^\/channels\/\d+$/.test(path) && request.method === 'PATCH') {
      const body = await request.json();
      this.record('archive', { id: path.split('/')[2], body });
      return Response.json({ id: path.split('/')[2], ...body });
    }
    if (path.endsWith('/callback')) {
      this.record('callback', { path, body: await request.json(), authorization: request.headers.get('Authorization'), at: Date.now() });
      return new Response(null, { status: 204 });
    }
    if (path.startsWith('/webhooks/') && request.method === 'PATCH') {
      this.record('edit', { path, body: await request.json(), authorization: request.headers.get('Authorization') });
      return Response.json({ id: '993456789012345678' });
    }
    if (/^\/channels\/\d+\/messages$/.test(path) && request.method === 'GET') {
      this.record('history', { path, before: url.searchParams.get('before'), limit: url.searchParams.get('limit') });
      if (this.mode === 'history-denied') return Response.json({}, { status: 403 });
      const messages = this.contextMessages ?? [
        { id: '503456789012345678', type: 0, author: { username: 'Pat' }, content: 'Newer channel background.' },
        { id: '502456789012345678', type: 0, author: { global_name: 'Alex' }, content: 'Earlier channel background.' },
        { id: '501456789012345678', type: 7, author: { username: 'System' }, content: 'A system notice.' },
      ];
      return Response.json(messages.filter(message => BigInt(message.id) < BigInt(url.searchParams.get('before'))).slice(0, Number(url.searchParams.get('limit'))));
    }
    if (path.endsWith('/messages') && request.method === 'POST') {
      const body = await request.json();
      this.record('message-attempt', { path, body });
      if (this.mode === 'history-denied' && body.message_reference) return Response.json({}, { status: 403 });
      if (this.mode === 'delivery-fail') return Response.json({}, { status: 503 });
      if (this.mode === 'message-429' && !this.rateLimited.has(body.nonce)) {
        this.rateLimited.add(body.nonce);
        return Response.json({ retry_after: 0.05, global: true }, { status: 429, headers: { 'X-RateLimit-Bucket': 'messages', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '0.05' } });
      }
      if (!this.nonces.has(body.nonce)) { this.nonces.add(body.nonce); this.record('delivery', { path, body }); }
      return Response.json({ id: '983456789012345678' });
    }
    if (/^\/channels\/\d+\/messages\/\d+$/.test(path) && request.method === 'GET') {
      this.record('reference', { path });
      const id = path.split('/').at(-1);
      if (Object.hasOwn(this.contextTargets, id)) return this.contextTargets[id]
        ? Response.json(this.contextTargets[id]) : Response.json({}, { status: 404 });
      return Response.json({ id: path.split('/').at(-1), author: { id: '123456789012345678', bot: true } });
    }
    if (path.endsWith('/typing')) return new Response(null, { status: 204 });
    if (path.endsWith('/chat/completions')) {
      const body = await request.json();
      this.record('model', { body, authorization: request.headers.get('Authorization') });
      if (this.mode === 'model-failure') return Response.json({ error: { message: 'synthetic failure' } }, { status: 503 });
      if (this.mode === 'slow-model') await new Promise(resolve => setTimeout(resolve, 600));
      if (this.mode === 'unsafe-model') return Response.json({ choices: [{ message: {
        role: 'assistant', content: String.fromCharCode(110, 105, 103, 103, 101, 114).toUpperCase(),
      }, finish_reason: 'stop' }] });
      const last = body.messages.at(-1);
      if (this.mode === 'connection-model') {
        const envelope = body.messages.find(message => message.role === 'user' && message.content.startsWith('{"lore_context":'));
        const context = envelope ? JSON.parse(envelope.content).lore_context : undefined;
        const source = context?.entries.find(item => item.entry.id === 'immortals-delight')?.source_id;
        return Response.json({ choices: [{ message: { role: 'assistant', content: source && context.connection
          ? 'This reminds me of Immortal’s Delight! A favorite milk-tea treat. [' + source + ']' : 'No connection was supplied.' }, finish_reason: 'stop' }] });
      }
      if (this.mode === 'lore-model') {
        const source = last.role === 'tool' ? JSON.parse(last.content).entries[0]?.source_id : undefined;
        return Response.json({ choices: [{ message: last.role === 'user'
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'local-lore', type: 'function', function: { name: 'lore_search', arguments: '{"query":"Vidyadhara"}' } }] }
          : { role: 'assistant', content: 'Verified synthetic lore [' + source + '].' }, finish_reason: 'stop' }] });
      }
      if (this.mode === 'story-model') {
        const context = body.messages.find(message => message.role === 'user' && message.content.startsWith('{"lore_context":'));
        const entries = context ? JSON.parse(context.content).lore_context.entries : [];
        const source = entries.find(item => item.entry.spoiler === 'story')?.source_id;
        const content = source ? 'An ordinary setting fact.\n\n' + 'A synthetic plot revelation. '.repeat(100) + '[' + source + '].' : 'A setting-only explanation.';
        return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      }
      const message = last.role === 'user' && last.content.includes('search')
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'lookup-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"synthetic documentation"}' } }] }
        : { role: 'assistant', content: last.role === 'tool' ? 'Verified synthetic evidence [S1].' : 'A synthetic reply.' };
      return Response.json({ choices: [{ message, finish_reason: 'stop' }] });
    }
    if (path.endsWith('/tools/search')) {
      this.record('search', { body: await request.json(), authorization: request.headers.get('Authorization') });
      return Response.json({ results: [{ url: 'https://example.com/source', title: 'Synthetic source', summary: 'Synthetic evidence.' }] });
    }
    this.record('unexpected', { host: url.hostname, path, method: request.method });
    return new Response('Unexpected mock route', { status: 500 });
  }
}

export default {
  fetch(request, env) {
    if (!['discord.com', 'cdn.discordapp.com', 'media.discordapp.net', 'gateway.discord.gg', 'resume.discord.gg', 'ai.probe.invalid', 'web.probe.invalid', 'control.probe.invalid', 'hsr.gachabase.net'].includes(new URL(request.url).hostname)) {
      return new Response('External network disabled', { status: 403 });
    }
    return env.MOCK.getByName('services').fetch(request);
  },
};
