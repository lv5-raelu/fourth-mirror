// Local feasibility probe, not a production bot entry point.
import { DurableObject } from 'cloudflare:workers';
import { ChatService } from '../../src/chat/service.ts';
import { OpenAICompatibleProvider } from '../../src/chat/provider.ts';
import { DeepSeekWebProvider } from '../../src/chat/web/deepseek.ts';
import { splitDiscordMessage } from '../../src/chat/messages.ts';
import { MAX_SESSIONS } from '../../src/chat/limits.ts';
import persona from '../../personas/fourth-mirror.md';

class SqlChatStore {
  constructor(sql) {
    this.sql = sql;
    this.sessions = new Map();
    sql.exec('CREATE TABLE IF NOT EXISTS sessions (thread_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at REAL NOT NULL)');
    for (const row of sql.exec('SELECT thread_id, data FROM sessions')) {
      this.sessions.set(row.thread_id, JSON.parse(row.data));
    }
  }

  get(threadId) { return this.sessions.get(threadId); }

  async put(session) {
    // One row per thread avoids the 2 MB per-value limit for a combined transcript.
    this.sql.exec('INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at',
      session.threadId, JSON.stringify(session), session.updatedAt);
    this.sessions.set(session.threadId, session);
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      this.sql.exec('DELETE FROM sessions WHERE thread_id = ?', oldest.threadId);
      this.sessions.delete(oldest.threadId);
    }
  }
}

export class BotProbe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    this.store = new SqlChatStore(this.sql);
    this.chat = new ChatService(new OpenAICompatibleProvider({
      apiKey: 'synthetic-ai-key', model: 'synthetic-model', baseUrl: 'https://ai.probe.invalid/v1',
      systemPrompt: persona, maxOutputTokens: 256, tokenLimitParam: 'max_tokens', historyFile: 'unused',
    }, new DeepSeekWebProvider({ apiKey: 'synthetic-web-key', baseUrl: 'https://web.probe.invalid/tools' })), this.store);
    this.socket = null;
    this.connecting = false;
    this.ready = false;
    this.awaitingAck = false;
    this.acks = 0;
    this.errors = [];
    this.active = new Set();
    // Accelerated only for this synthetic probe; a production watchdog would run less often.
    this.watchdogMs = 500;
    this.session = this.getState('session');
    this.running = this.getState('running') === true;
    this.blocked = this.getState('blocked');
    // Start and persisted alarms own reconnection. Status polling must not hide
    // broken unattended recovery by reconnecting from the constructor.
  }

  getState(key) {
    const row = [...this.sql.exec('SELECT value FROM state WHERE key = ?', key)][0];
    return row ? JSON.parse(row.value) : null;
  }

  setState(key, value) {
    this.sql.exec('INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  }

  track(promise) {
    const task = promise.catch(() => { this.errors.push('handler_failed'); }).finally(() => this.active.delete(task));
    this.active.add(task);
    this.ctx.waitUntil(task);
  }

  async connect() {
    if (!this.running || this.blocked || this.socket || this.connecting) return;
    this.connecting = true;
    try {
      // The test harness routes this hostname to a synthetic Gateway. No Discord token is used.
      const url = new URL(this.session?.url ?? 'wss://gateway.probe.invalid');
      url.protocol = 'https:';
      url.search = '?v=10&encoding=json';
      const response = await fetch(url, { headers: { Upgrade: 'websocket' } });
      if (response.status !== 101 || !response.webSocket) throw new Error('Gateway upgrade failed');
      const socket = response.webSocket;
      this.socket = socket;
      socket.accept();
      socket.addEventListener('message', (event) => {
        if (this.socket === socket) this.track(this.onPacket(JSON.parse(event.data)));
      });
      socket.addEventListener('close', (event) => {
        if (this.socket !== socket) return;
        clearTimeout(this.heartbeat);
        this.socket = null;
        this.ready = false;
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
          this.blocked = event.code;
          this.setState('blocked', event.code);
        } else if ([4007, 4009].includes(event.code)) {
          this.session = null;
          this.setState('session', null);
        }
        if (this.running && !this.blocked) this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 100));
      });
      socket.addEventListener('error', () => { this.errors.push('socket_error'); });
      await this.ctx.storage.setAlarm(Date.now() + this.watchdogMs);
    } catch {
      this.errors.push('connect_failed');
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    } finally {
      this.connecting = false;
    }
  }

  send(op, d) { this.socket?.send(JSON.stringify({ op, d })); }

  sendHeartbeat() {
    this.awaitingAck = true;
    this.send(1, this.session?.sequence ?? null);
  }

  scheduleHeartbeat(interval) {
    this.heartbeat = setTimeout(() => {
      if (this.awaitingAck) {
        this.socket?.close(4000, 'Heartbeat ACK missing');
        return;
      }
      this.sendHeartbeat();
      // Schedule a new operation each interval; do not rely on one permanent socket
      // keeping an object alive beyond the platform's 15-minute operation window.
      this.scheduleHeartbeat(interval);
    }, interval);
  }

  async onPacket(packet) {
    if (packet.op === 10) {
      this.awaitingAck = false;
      this.scheduleHeartbeat(packet.d.heartbeat_interval);
      if (this.session) {
        this.send(6, { token: 'synthetic-discord-token', session_id: this.session.id, seq: this.session.sequence });
      } else {
        this.send(2, { token: 'synthetic-discord-token', intents: 1 | 512 | 32768,
          properties: { os: 'cloudflare', browser: 'fourth-mirror-probe', device: 'fourth-mirror-probe' } });
      }
    } else if (packet.op === 11) {
      this.awaitingAck = false;
      this.acks++;
    } else if (packet.op === 1) {
      this.sendHeartbeat();
    } else if (packet.op === 7) {
      this.socket?.close(4000, 'Gateway requested reconnect');
    } else if (packet.op === 0) {
      if (packet.t === 'READY') {
        this.session = { id: packet.d.session_id, sequence: packet.s, url: packet.d.resume_gateway_url };
        this.ready = true;
      } else if (packet.t === 'RESUMED') {
        this.ready = true;
      }
      if (this.session && packet.s !== null) {
        this.session.sequence = packet.s;
        this.setState('session', this.session);
      }
      if (packet.t === 'MESSAGE_CREATE') await this.onMessage(packet.d);
    }
  }

  async onMessage(message) {
    if (message.guild_id !== '323456789012345678' || message.author.bot || message.webhook_id) return;
    const session = this.store.get(message.channel_id);
    if (!session || session.ownerId !== message.author.id) return;
    const inserted = this.sql.exec('INSERT OR IGNORE INTO events VALUES (?, ?)', message.id, 'pending');
    if (inserted.rowsWritten === 0) return;
    try {
      await this.chat.reply(message.channel_id, message.author.id, message.content, async (text) => {
        for (const content of splitDiscordMessage(text)) {
          const response = await fetch(`https://discord.probe.invalid/api/v10/channels/${message.channel_id}/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bot synthetic-discord-token' },
            body: JSON.stringify({ content, allowed_mentions: { parse: [], replied_user: false } }),
          });
          if (!response.ok) throw new Error('Delivery failed');
          await response.body?.cancel();
        }
      });
      this.sql.exec('UPDATE events SET status = ? WHERE id = ?', 'complete', message.id);
    } catch {
      this.sql.exec('UPDATE events SET status = ? WHERE id = ?', 'failed', message.id);
      this.errors.push('reply_failed');
    }
  }

  async alarm() {
    if (this.running && !this.blocked) {
      await this.connect();
      await this.ctx.storage.setAlarm(Date.now() + this.watchdogMs);
    }
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/crash') {
      this.ctx.abort('Synthetic crash for recovery testing');
    } else if (path === '/start') {
      this.running = true;
      this.setState('running', true);
      await this.connect();
    } else if (path === '/stop') {
      this.running = false;
      this.setState('running', false);
      await this.ctx.storage.deleteAlarm();
      clearTimeout(this.heartbeat);
      const socket = this.socket;
      this.socket = null;
      this.ready = false;
      socket?.close(1000, 'Probe stopped');
      await Promise.all(this.active);
    } else if (path === '/create') {
      const { ownerId, threadId } = await request.json();
      await this.chat.create(ownerId, async () => threadId);
    } else if (path === '/reset') {
      const { ownerId, threadId } = await request.json();
      await this.chat.reset(threadId, ownerId);
    }
    return Response.json({
      ready: this.ready, acks: this.acks, blocked: this.blocked, session: this.session,
      sessions: [...this.store.sessions.values()], errors: this.errors,
      events: [...this.sql.exec('SELECT id, status FROM events')],
    });
  }
}

export default {
  fetch(request, env) {
    // A dry-run bundle must never accidentally become a public bot deployment.
    if (env.PROBE_LOCAL !== 'true') return new Response('Local feasibility probe only.', { status: 503 });
    if (request.headers.get('Authorization') !== `Bearer ${env.PROBE_SECRET}`) return new Response('Unauthorized', { status: 401 });
    // A fixed object name is essential: one object for the whole bot, not one per chat.
    return env.BOT.getByName('singleton').fetch(request);
  },
};
