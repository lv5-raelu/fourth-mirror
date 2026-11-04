import type { Config } from '../../src/config-values.ts';
import { BotStorage } from './storage.ts';
import { DiscordRest, DiscordError } from './rest.ts';
import { upgradeWebSocket } from './websocket.ts';

export interface Dispatch { t: string; s: number; d: unknown }
interface Session { id: string; url: string; sequence: number; applicationId: string }
interface State {
  running: boolean;
  accepting: boolean;
  blocked: string | null;
  nextConnectAt: number;
  failures: number;
  lastIdentifyAt: number;
  session: Session | null;
  botId?: string;
  connections: number;
  lastDisconnect?: { code: number | null; reason: string; opcode: number | null; event: string | null };
}
export interface GatewayTiming {
  watchdog: number; identify: number; reconnect: number; maxReconnect: number;
  hello: number; invalidSession: number;
}
export const gatewayTiming: GatewayTiming = {
  watchdog: 60_000, identify: 5_000, reconnect: 1_000, maxReconnect: 60_000, hello: 15_000, invalidSession: 1_000,
};
const initial: State = { running: false, accepting: false, blocked: null, nextConnectAt: 0,
  failures: 0, lastIdentifyAt: 0, session: null, connections: 0 };

function gatewayUrl(value: string): URL {
  const url = new URL(value);
  // Never send a Discord token to a redirect or an arbitrary saved host.
  if (url.protocol !== 'wss:' || !(url.hostname === 'gateway.discord.gg' || url.hostname.endsWith('.discord.gg')) || url.port || url.username || url.password) {
    throw new Error('Invalid Discord Gateway URL.');
  }
  url.protocol = 'https:';
  url.search = '?v=10&encoding=json';
  url.hash = '';
  return url;
}

export class Gateway {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private identifyTimer: ReturnType<typeof setTimeout> | undefined;
  private awaitingAck = false;
  private heartbeatAt = 0;
  private heartbeatInterval = 0;
  ready = false;
  lastAckAt = 0;
  latency: number | null = null;
  lastOpcode: number | null = null;
  lastEvent: string | null = null;

  private readonly ctx: DurableObjectState;
  private readonly store: BotStorage;
  private readonly rest: DiscordRest;
  private readonly config: Config;
  private readonly dispatch: (packet: Dispatch) => void;
  private readonly onReady: () => void;
  readonly timing: GatewayTiming;
  constructor(ctx: DurableObjectState, store: BotStorage, rest: DiscordRest, config: Config,
    dispatch: (packet: Dispatch) => void, onReady: () => void, timing: GatewayTiming = gatewayTiming) {
    this.ctx = ctx; this.store = store; this.rest = rest; this.config = config;
    this.dispatch = dispatch; this.onReady = onReady; this.timing = timing;
  }

  state(): State { return this.store.getState<State>('gateway') ?? { ...initial }; }
  patch(value: Partial<State>): void { this.store.setState('gateway', { ...this.state(), ...value }); }

  sequence(sequence: number): void {
    const session = this.state().session;
    if (session) this.patch({ session: { ...session, sequence } });
  }

  async start(): Promise<void> {
    this.patch({ running: true, accepting: true, blocked: null, nextConnectAt: 0, failures: 0 });
    // Commit a watchdog before network I/O, including a failed/abandoned initial connection.
    await this.schedule(Date.now() + this.timing.watchdog);
    await this.tick();
  }

  async stop(): Promise<void> {
    this.patch({ running: false, accepting: false });
    this.detach();
    await this.ctx.storage.deleteAlarm();
  }

  async tick(): Promise<void> {
    const state = this.state();
    if (!state.running || state.blocked) return;
    await this.schedule(Date.now() + this.timing.watchdog);
    if (this.socket || this.connecting) return;
    const eligibleAt = Math.max(state.nextConnectAt, state.session ? 0 : state.lastIdentifyAt + this.timing.identify);
    if (Date.now() < eligibleAt) {
      await this.schedule(Math.min(eligibleAt, Date.now() + this.timing.watchdog));
      return;
    }
    this.connecting = this.connect().finally(() => { this.connecting = null; });
    await this.connecting;
  }

  private async schedule(time: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current <= Date.now() || time < current) await this.ctx.storage.setAlarm(time);
  }

  private async connect(): Promise<void> {
    try {
      if (this.state().session && this.state().session?.applicationId !== this.config.applicationId) this.patch({ session: null });
      const state = this.state();
      let url = state.session?.url;
      if (!url) {
        const info = await this.rest.request<{ url: string; shards: number;
          session_start_limit: { remaining: number; reset_after: number } }>('GET', '/gateway/bot');
        if (info.shards > 1) { await this.block('sharding_required'); return; }
        if (!info.session_start_limit || !Number.isFinite(info.session_start_limit.remaining)) throw new Error('Invalid Gateway limits.');
        if (info.session_start_limit.remaining <= 0) {
          this.patch({ nextConnectAt: Date.now() + Math.max(60_000, info.session_start_limit.reset_after || 86400_000) });
          return;
        }
        url = info.url;
      }
      if (!this.state().running) return;
      const response = await upgradeWebSocket(gatewayUrl(url), this.timing.hello);
      if (response.status !== 101 || !response.webSocket) {
        await response.body?.cancel();
        throw new Error('Gateway did not upgrade.');
      }
      const socket = response.webSocket;
      socket.accept();
      if (!this.state().running) { socket.close(4000, 'Stopped'); return; }
      this.socket = socket;
      this.patch({ connections: this.state().connections + 1 });
      this.awaitingAck = false;
      this.helloTimer = setTimeout(() => { if (this.socket === socket && !this.ready) this.drop(undefined, 'handshake_timeout'); }, this.timing.hello);
      socket.addEventListener('message', event => {
        if (this.socket !== socket) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 8_000_000) { this.drop(undefined, 'unexpected_frame'); return; }
          this.packet(JSON.parse(event.data) as { op: number; d: unknown; t?: string; s?: number });
        } catch {
          // A failed journal/sequence commit must discard this instance, not acknowledge a lost dispatch.
          this.ctx.abort('Gateway state could not be processed.');
        }
      });
      socket.addEventListener('close', event => {
        if (this.socket !== socket) return;
        this.patch({ lastDisconnect: { code: event.code, reason: 'remote_close', opcode: this.lastOpcode, event: this.lastEvent } });
        this.detach(false);
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
          this.ctx.waitUntil(this.block('discord_close_' + event.code));
          return;
        }
        if ([4007, 4009].includes(event.code) || [1000, 1001].includes(event.code)) this.patch({ session: null });
        this.ctx.waitUntil(this.retry());
      });
      socket.addEventListener('error', () => { if (this.socket === socket) this.drop(undefined, 'socket_error'); });
    } catch (error) {
      if (error instanceof DiscordError && [401, 403].includes(error.status)) await this.block('discord_auth_' + error.status);
      else await this.retry();
    }
  }

  private packet(packet: { op: number; d: unknown; t?: string; s?: number }): void {
    this.lastOpcode = typeof packet.op === 'number' ? packet.op : null;
    this.lastEvent = packet.t ?? this.lastEvent;
    if (packet.op === 10) {
      const interval = (packet.d as { heartbeat_interval?: number } | null)?.heartbeat_interval;
      if (!interval || !Number.isFinite(interval) || interval < 50 || interval > 120_000) { this.drop(); return; }
      this.heartbeatInterval = interval;
      this.scheduleHeartbeat(Math.random() * interval);
      const session = this.state().session;
      if (session) this.send(6, { token: this.config.token, session_id: session.id, seq: session.sequence });
      else {
        const identify = (): void => {
          if (!this.socket || !this.state().running) return;
          this.patch({ lastIdentifyAt: Date.now() });
          this.send(2, { token: this.config.token, intents: 1 | (this.config.ai ? 512 | 32768 : 0),
            properties: { os: 'cloudflare', browser: 'fourth-mirror', device: 'fourth-mirror' } });
        };
        const delay = this.state().lastIdentifyAt + this.timing.identify - Date.now();
        if (delay > 0) this.identifyTimer = setTimeout(identify, delay);
        else identify();
      }
    } else if (packet.op === 11) {
      this.awaitingAck = false;
      this.lastAckAt = Date.now();
      this.latency = Math.max(0, this.lastAckAt - this.heartbeatAt);
    } else if (packet.op === 1) this.sendHeartbeat();
    else if (packet.op === 7) this.drop();
    else if (packet.op === 9) {
      if (packet.d !== true) this.patch({ session: null });
      this.drop(this.timing.invalidSession * (1 + Math.random() * 4));
    } else if (packet.op === 0 && typeof packet.s === 'number' && Number.isSafeInteger(packet.s) && packet.t) {
      if (packet.t === 'READY') {
        const data = packet.d as { session_id: string; resume_gateway_url: string; user: { id: string }; application: { id: string } };
        if (data.application?.id !== this.config.applicationId || !data.user?.id || !data.session_id) {
          this.ctx.waitUntil(this.block('application_id_mismatch')); return;
        }
        gatewayUrl(data.resume_gateway_url);
        this.patch({ session: { id: data.session_id, url: data.resume_gateway_url, sequence: packet.s, applicationId: this.config.applicationId }, botId: data.user.id, failures: 0 });
        this.markReady();
      } else if (packet.t === 'RESUMED') {
        this.sequence(packet.s);
        this.patch({ failures: 0 });
        this.markReady();
      } else {
        // The actor commits the message journal and sequence in the same SQL transaction.
        this.dispatch({ t: packet.t, s: packet.s, d: packet.d });
      }
    }
  }

  private markReady(): void {
    clearTimeout(this.helloTimer);
    this.ready = true;
    this.onReady();
  }

  private send(op: number, d: unknown): void {
    try { this.socket?.send(JSON.stringify({ op, d })); }
    catch { this.drop(); }
  }

  private sendHeartbeat(): void {
    this.awaitingAck = true;
    this.heartbeatAt = Date.now();
    this.send(1, this.state().session?.sequence ?? null);
  }

  private scheduleHeartbeat(delay: number): void {
    clearTimeout(this.heartbeat);
    this.heartbeat = setTimeout(() => {
      if (!this.socket) return;
      if (this.awaitingAck) { this.drop(undefined, 'heartbeat_timeout'); return; }
      this.sendHeartbeat();
      if (this.socket) this.scheduleHeartbeat(this.heartbeatInterval);
    }, delay);
  }

  private detach(close = true): void {
    clearTimeout(this.heartbeat);
    clearTimeout(this.helloTimer);
    clearTimeout(this.identifyTimer);
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (close) try { socket?.close(4000, 'Reconnecting'); } catch { /* Already closed. */ }
  }

  private drop(delay?: number, reason = 'reconnect'): void {
    this.patch({ lastDisconnect: { code: null, reason, opcode: this.lastOpcode, event: this.lastEvent } });
    this.detach();
    this.ctx.waitUntil(this.retry(delay));
  }

  private async retry(delay?: number): Promise<void> {
    const state = this.state();
    if (!state.running || state.blocked) return;
    const failures = Math.min(state.failures + 1, 16);
    const backoff = delay ?? Math.min(this.timing.maxReconnect, this.timing.reconnect * 2 ** (failures - 1)) * (0.8 + Math.random() * 0.4);
    const nextConnectAt = Date.now() + backoff;
    this.patch({ failures, nextConnectAt });
    await this.schedule(nextConnectAt);
  }

  private async block(reason: string): Promise<void> {
    this.patch({ blocked: reason, accepting: false });
    this.detach();
    await this.ctx.storage.deleteAlarm();
  }
}
