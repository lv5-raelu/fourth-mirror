import { DurableObject } from 'cloudflare:workers';
import './media.ts';
import { ChatService } from '../../src/chat/service.ts';
import { ChatError } from '../../src/chat/types.ts';
import { OpenAICompatibleProvider } from '../../src/chat/provider.ts';
import { DeepSeekWebProvider } from '../../src/chat/web/deepseek.ts';
import { splitDiscordMessage } from '../../src/chat/messages.ts';
import { commandDefinitions, mentionHelp } from '../../src/commands/definitions.ts';
import { workerConfig } from './config.ts';
import type { Env } from './config.ts';
import { BotStorage } from './storage.ts';
import type { JournalEntry } from './storage.ts';
import { DiscordRest, DiscordError } from './rest.ts';
import { Gateway, gatewayTiming } from './gateway.ts';
import type { Dispatch, GatewayTiming } from './gateway.ts';
import { hasBotMention, withoutBotMention } from '../../src/chat/group.ts';
import { missingChatThreadPermissions } from '../../src/chat/permissions.ts';
import { CONTEXT_TIMEOUT_MS, loadChannelContext } from '../../src/chat/context.ts';
import type { DiscordContextMessage } from '../../src/chat/context.ts';
import { BetaClient } from '../../src/beta/source.ts';
import { ServerBeta } from '../../src/beta/servers.ts';
import { allowsGuild } from '../../src/config-values.ts';
import { executeBeta } from '../../src/beta/feature.ts';
import type { BetaMessage } from '../../src/beta/types.ts';
import { latestMessage } from '../../src/beta/presentation.ts';
import { betaChannelPermissions } from '../../src/beta/permissions.ts';
import { loreCatalogueInfo } from '../../src/lore/index.ts';
import { collectDiscordMedia } from '../../src/chat/media.ts';
import type { DiscordAttachment, DiscordEmbed, DiscordSticker } from '../../src/chat/media.ts';

interface User { id: string; bot?: boolean; username?: string; global_name?: string }
interface InteractionOption { name: string; type?: number; value?: unknown; options?: InteractionOption[] }
interface Interaction {
  id: string; type: number; token: string; application_id: string; guild_id?: string; channel_id: string;
  app_permissions?: string; member?: { user: User; permissions?: string; nick?: string; communication_disabled_until?: string | null };
  data?: { type?: number; name?: string; options?: InteractionOption[] };
}
interface Message {
  id: string; guild_id?: string; channel_id: string; author: User; content: string;
  webhook_id?: string; type?: number; attachments?: DiscordAttachment[]; sticker_items?: DiscordSticker[]; embeds?: DiscordEmbed[];
  mentions?: User[]; member?: { nick?: string };
  message_reference?: { type?: number; message_id?: string; channel_id?: string };
  referenced_message?: { author: User; webhook_id?: string } | null;
}
interface Channel { id: string; type: number; guild_id?: string; permission_overwrites?: { id: string; type: number; allow: string; deny: string }[] }

const idPattern = /^[1-9]\d{16,19}$/;
const userPermissions = 1024n | (1n << 38n);
function hasPermissions(value: string | undefined, required: bigint): boolean {
  if (!value || !/^\d+$/.test(value)) return false;
  const permissions = BigInt(value);
  return (permissions & 8n) !== 0n || (permissions & required) === required;
}
const recoveryText = 'I restarted before confirming your last reply. It may be incomplete. Please resend your message if you still need an answer.';

function sameThreadReply(message: Message): string | undefined {
  const reference = message.message_reference;
  return reference?.message_id && idPattern.test(reference.message_id) && (reference.type ?? 0) === 0 &&
    (reference.channel_id ?? message.channel_id) === message.channel_id ? reference.message_id : undefined;
}

function mentionsBot(message: Message, botId: string): boolean {
  return Boolean(message.mentions?.some(user => user.id === botId));
}

export class DiscordBot extends DurableObject<Env> {
  protected readonly store: BotStorage;
  protected readonly gateway: Gateway;
  private readonly rest: DiscordRest;
  private readonly config: ReturnType<typeof workerConfig>;
  private readonly chat: ChatService | null;
  private readonly beta: ServerBeta;
  private readonly active = new Set<Promise<void>>();
  private draining: Promise<void> | null = null;
  private recovering = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = workerConfig(env);
    this.store = new BotStorage(ctx.storage);
    this.rest = new DiscordRest(this.config.token);
    const betaClient = new BetaClient();
    this.beta = new ServerBeta(betaClient, {
      load: async guildId => this.store.betaState(guildId),
      save: async state => { this.store.saveBetaState(state); },
      list: async () => this.store.betaStates(),
    });
    this.chat = this.config.ai ? new ChatService(new OpenAICompatibleProvider(this.config.ai,
      this.config.web ? new DeepSeekWebProvider(this.config.web) : undefined), this.store) : null;
    this.gateway = new Gateway(ctx, this.store, this.rest, this.config,
      packet => this.dispatch(packet), () => this.track(() => this.recover()), this.timings());
  }

  protected timings(): GatewayTiming { return gatewayTiming; }

  private track(task: () => Promise<void>): void {
    const pending = Promise.resolve().then(task).catch(() => {
      console.warn('Bot background task could not finish.');
    }).finally(() => this.active.delete(pending));
    this.active.add(pending);
    this.ctx.waitUntil(pending);
  }

  private dispatch(packet: Dispatch): void {
    let task: (() => Promise<void>) | undefined;
    this.ctx.storage.transactionSync(() => {
      const data = packet.d as Partial<Interaction & Message> | null;
      if (this.active.size < 50 && data && typeof data.id === 'string' && idPattern.test(data.id) && typeof data.channel_id === 'string' && idPattern.test(data.channel_id)) {
        if (packet.t === 'INTERACTION_CREATE' && data.type === 2 && data.data?.type !== 2 && data.data?.type !== 3 &&
          data.application_id === this.config.applicationId && typeof data.token === 'string' && data.member?.user?.id) {
          const interaction = data as Interaction;
          const entry: JournalEntry = { id: interaction.id, kind: 'interaction', channelId: interaction.channel_id,
            token: interaction.token, command: interaction.data?.name ?? '', createdAt: Date.now() };
          if (this.store.claim(entry)) task = () => this.command(interaction, entry);
        } else if (packet.t === 'MESSAGE_CREATE' && this.chat && allowsGuild(this.config, data.guild_id) &&
          data.author?.id && !data.author.bot && !data.webhook_id && [0, 19].includes(data.type ?? 0)) {
          const session = this.chat.getSession(data.channel_id);
          const candidate = data as Message;
          if (session ? (session.mode === 'group'
            ? mentionsBot(candidate, this.config.applicationId) || sameThreadReply(candidate)
            : session.ownerId === data.author.id)
            : mentionsBot(candidate, this.config.applicationId) && typeof candidate.content === 'string' && hasBotMention(candidate.content, this.config.applicationId)) {
            const message = data as Message;
            // Only delivery metadata is journaled; one-off prompts, context, and answers are never saved.
            const entry: JournalEntry = { id: message.id, kind: session ? 'message' : 'mention', channelId: message.channel_id, createdAt: Date.now() };
            if (this.store.claim(entry)) task = () => this.message(message, entry);
          }
        }
      }
      this.gateway.sequence(packet.s);
    });
    if (task) this.track(task);
  }

  private async chatThread(channelId: string, deadlineMs = 20_000, guildId?: string): Promise<boolean> {
    const channel = await this.rest.request<Channel>('GET', `/channels/${channelId}`, undefined, { deadlineMs });
    const session = this.chat?.getSession(channelId);
    return Boolean(session) && allowsGuild(this.config, channel.guild_id) && (!guildId || channel.guild_id === guildId) &&
      (channel.type === 12 || (channel.type === 11 && session?.mode === 'group'));
  }

  private async command(interaction: Interaction, entry: JournalEntry): Promise<void> {
    let deferred = false;
    let outcome: 'complete' | 'failed' | null = 'complete';
    const deadline = Date.now() + 110_000;
    const remaining = (): number => Math.max(1, Math.min(20_000, deadline - Date.now()));
    const edit = (content: string | BetaMessage): Promise<void> => this.rest.editInteraction(this.config.applicationId, interaction.token, content, remaining());
    try {
      // Acknowledge before channel checks or other REST work. Do not queue behind ordinary messages.
      await this.rest.request('POST', `/interactions/${interaction.id}/${encodeURIComponent(interaction.token)}/callback`,
        { type: 5, data: { flags: 64 } }, { immediate: true, deadlineMs: 2_000, auth: false });
      deferred = true;
      if (!allowsGuild(this.config, interaction.guild_id)) { await edit('This bot is not enabled in this server.'); return; }
      if (!this.gateway.state().accepting || this.active.size > 50) { await edit('I’m updating or busy. Please try the command again shortly.'); return; }
      const name = interaction.data?.name;
      if (name === 'ping') {
        await edit(`Pong! Gateway heartbeat: ${this.gateway.latency === null ? 'measuring…' : `${Math.round(this.gateway.latency)} ms`}`);
      } else if (name === 'help') {
        await edit(['Available commands:', ...Object.values(commandDefinitions).sort((a, b) => a.name.localeCompare(b.name))
          .map(command => `**/${command.name}** — ${command.description}`), '', mentionHelp].join('\n'));
      } else if (name === 'beta') {
        const action = interaction.data?.options?.[0];
        const option = (name: string): unknown => action?.options?.find(option => option.name === name)?.value;
        const question = option('question'), channelId = option('channel'), enabled = option('enabled');
        await executeBeta({ action: action?.name ?? '', userId: interaction.member!.user.id,
          canManage: hasPermissions(interaction.member?.permissions, 32n),
          ...(typeof question === 'string' ? { question } : {}), ...(typeof channelId === 'string' && idPattern.test(channelId) ? { channelId } : {}),
          ...(typeof enabled === 'boolean' ? { enabled } : {}),
        }, this.beta.forGuild(interaction.guild_id), this.chat, edit, id => this.validateBetaChannel(id, interaction.guild_id!));
      } else if (name === 'chat' || name === 'reset') {
        if (!this.chat) { await edit('AI chat is not configured yet. Please contact the bot owner.'); return; }
        if (name === 'reset') {
          if (!await this.chatThread(interaction.channel_id, remaining(), interaction.guild_id)) throw new ChatError('Use /reset inside a conversation started with /chat.');
          await this.chat.reset(interaction.channel_id, interaction.member!.user.id);
          await edit('Conversation context cleared. Your next message starts fresh. Earlier Discord messages remain visible.');
        } else await this.createChat(interaction, entry, edit, remaining);
      } else await edit('That command is no longer available. The bot owner needs to sync commands.');
    } catch (error) {
      this.store.setState('lastFailure', { at: Date.now(), kind: 'interaction', expected: error instanceof ChatError });
      outcome = 'failed';
      if (entry.createdThreadId && !this.chat?.getSession(entry.createdThreadId)) {
        await this.rest.request('PATCH', `/channels/${entry.createdThreadId}`, { archived: true }, { deadlineMs: remaining() }).catch(() => {
          this.store.interrupt(entry.id); outcome = null;
        });
      }
      if (deferred) await edit(error instanceof ChatError ? error.message : 'Something went wrong running that command. Please try again later.').catch(() => {});
      return;
    } finally {
      // Pending work is also finished on validation/disabled early returns.
      if (outcome) this.store.finish(entry.id, outcome);
    }
  }

  private async validateBetaChannel(channelId: string, guildId: string): Promise<void> {
    const botId = this.gateway.state().botId ?? this.config.applicationId;
    const [channel, roles, member] = await Promise.all([
      this.rest.request<Channel>('GET', `/channels/${channelId}`),
      this.rest.request<{ id: string; permissions: string }[]>('GET', `/guilds/${guildId}/roles`),
      this.rest.request<{ roles: string[] }>('GET', `/guilds/${guildId}/members/${botId}`),
    ]);
    if (channel.guild_id !== guildId || ![0, 5].includes(channel.type)) throw new ChatError('Choose a regular text or announcement channel in this server.');
    if (!betaChannelPermissions(guildId, botId, member.roles, roles, channel.permission_overwrites ?? [])) {
      throw new ChatError('I need View Channel, Send Messages, and Embed Links in the notification channel.');
    }
  }

  private async createChat(interaction: Interaction, entry: JournalEntry, edit: (content: string) => Promise<void>, remaining: () => number): Promise<void> {
    const mode = interaction.data?.options?.find(option => option.name === 'mode')?.value === 'group' ? 'group' : 'personal';
    const channel = await this.rest.request<Channel>('GET', `/channels/${interaction.channel_id}`, undefined, { deadlineMs: remaining() });
    if (channel.type !== 0 || channel.guild_id !== interaction.guild_id) {
      throw new ChatError('Run /chat in a regular server text channel to start a conversation.');
    }
    // Discord supplies effective channel permissions, including overwrites, in Gateway interactions.
    const missingPermissions = missingChatThreadPermissions(mode, bit => hasPermissions(interaction.app_permissions, bit));
    if (missingPermissions.length) {
      throw new ChatError(`Missing bot permissions here: ${missingPermissions.join(', ')}. Check this channel’s permission overrides.`);
    }
    if (!hasPermissions(interaction.member?.permissions, userPermissions) ||
      Date.parse(interaction.member?.communication_disabled_until ?? '') > Date.now()) {
      throw new ChatError('You need View Channel and Send Messages in Threads permissions here to use AI chat.');
    }
    const member = interaction.member!;
    const threadId = await this.chat!.create(member.user.id, async () => {
      const thread = await this.rest.request<Channel>('POST', `/channels/${channel.id}/threads`, {
        name: `${mode === 'group' ? 'Group chat' : 'Chat'} · ${member.nick || member.user.global_name || member.user.username || 'friend'}`.slice(0, 100),
        type: mode === 'group' ? 11 : 12, ...(mode === 'personal' ? { invitable: false } : {}), auto_archive_duration: 60,
      }, { deadlineMs: remaining() });
      if (!idPattern.test(thread.id) || thread.type !== (mode === 'group' ? 11 : 12)) throw new Error('Invalid created thread.');
      entry.createdThreadId = thread.id;
      this.store.updateEntry(entry);
      await this.rest.request('PUT', `/channels/${thread.id}/thread-members/${member.user.id}`, undefined, { deadlineMs: remaining() });
      await this.rest.message(thread.id,
        mode === 'group'
          ? 'Your public group chat is ready. Anyone who can view the parent channel can see and join this thread. Mention me or reply to one of my messages to ask a question. Addressed questions share one history and replies are queued in order. Only the person who started this chat can use /reset.\n\nAddressed messages are sent to the AI provider. Images, custom emojis, stickers, and GIFs can be sent for visual understanding.'
          : 'Your chat is ready. Send a message or image and I’ll reply here. Use /reset to start with fresh context.\n\nMessages are sent to the bot’s AI provider. Server moderators can access private threads. Images, custom emojis, stickers, and GIFs can be sent for visual understanding.', entry.id + 'w', remaining());
      return thread.id;
    }, mode);
    await edit(`Your conversation is ready: <#${threadId}>`);
  }

  private async message(message: Message, entry: JournalEntry): Promise<void> {
    let deadline = Date.now() + 110_000;
    const standalone = entry.kind === 'mention';
    const group = this.chat!.getSession(message.channel_id)?.mode === 'group';
    const remaining = (): number => Math.max(1, Math.min(20_000, deadline - Date.now()));
    const send = async (content: string, suffix: string): Promise<void> => {
      try {
        await this.rest.message(message.channel_id, content, message.id + suffix, remaining(), group || standalone ? message.id : undefined);
      } catch (error) {
        if (!standalone || !(error instanceof DiscordError) || error.status !== 403) throw error;
        await this.rest.message(message.channel_id, content, message.id + suffix, remaining());
      }
    };
    let typing: ReturnType<typeof setTimeout> | undefined;
    let shouldRespond: (() => Promise<boolean>) | undefined;
    try {
      if (!standalone && !await this.chatThread(message.channel_id, remaining(), message.guild_id)) return;
      if (!this.gateway.state().accepting || this.active.size > 50) {
        await send('I’m updating or busy. Please resend your message shortly.', 'p'); return;
      }
      if (group && !mentionsBot(message, this.config.applicationId)) {
        const id = sameThreadReply(message);
        if (!id) return;
        if (message.referenced_message !== undefined) {
          if (!message.referenced_message || message.referenced_message.author.id !== this.config.applicationId || message.referenced_message.webhook_id) return;
        } else shouldRespond = async () => {
          try {
            const reference = await this.rest.request<{ author: User; webhook_id?: string }>('GET', `/channels/${message.channel_id}/messages/${id}`);
            return reference.author.id === this.config.applicationId && !reference.webhook_id;
          } catch { return false; }
        };
      }
      const prompt = typeof message.content === 'string' ? (group || standalone ? withoutBotMention(message.content, this.config.applicationId) : message.content) : '';
      const media = collectDiscordMedia({ ...message, content: prompt });
      if (media.length && this.config.ai?.vision === false) throw new ChatError('Image understanding is disabled for this bot’s model. Please send a text question.');
      if (!prompt.trim() && !media.length) {
        await send(standalone ? 'Add a text question after mentioning me.' : 'I couldn’t read that message. Send text; if this keeps happening, ask the bot owner to check Message Content Intent.', 'n'); return;
      }
      const showTyping = (): void => {
        this.ctx.waitUntil(this.rest.request('POST', `/channels/${message.channel_id}/typing`, undefined, { deadlineMs: 1_000 }).then(() => {}, () => {}));
        typing = setTimeout(showTyping, 8_000);
      };
      const deliver = async (text: string): Promise<void> => {
        let chunk = 0;
        for (const content of splitDiscordMessage(text)) await send(content, String(chunk++));
      };
      const speakerName = message.member?.nick || message.author.global_name || message.author.username || 'User';
      const onStart = (): void => { deadline = Date.now() + 110_000; showTyping(); };
      if (standalone) await this.chat!.answer(message.author.id, prompt, deliver, {
        media,
        onStart,
        context: () => loadChannelContext(speakerName, message.channel_id, message.id, {
          botId: this.config.applicationId,
          ...(sameThreadReply(message) ? { referenceId: sameThreadReply(message)! } : {}),
          recent: (limit, signal) => this.rest.request<DiscordContextMessage[]>('GET', `/channels/${message.channel_id}/messages`, undefined,
            { deadlineMs: Math.min(CONTEXT_TIMEOUT_MS, remaining()), query: { before: message.id, limit }, signal }),
          message: (id, signal) => this.rest.request<DiscordContextMessage>('GET', `/channels/${message.channel_id}/messages/${id}`, undefined,
            { deadlineMs: Math.min(CONTEXT_TIMEOUT_MS, remaining()), signal }),
        }),
      });
      else await this.chat!.reply(message.channel_id, message.author.id, prompt, deliver, {
        media,
        speakerName,
        ...(shouldRespond ? { shouldRespond } : {}),
        onStart,
      });
    } catch (error) {
      deadline = Math.max(deadline, Date.now() + 20_000);
      this.store.setState('lastFailure', { at: Date.now(), kind: 'message', expected: error instanceof ChatError });
      await send(error instanceof ChatError ? error.message : 'Could not finish that reply. Please try again later.', 'e').catch(() => {});
      this.store.finish(entry.id, 'failed');
      return;
    } finally {
      clearTimeout(typing);
      this.store.finish(entry.id, 'complete');
    }
  }

  private async recover(): Promise<void> {
    if (this.recovering || !this.gateway.ready || !this.gateway.state().accepting) return;
    this.recovering = true;
    const deadline = Date.now() + 30_000;
    const remaining = (): number => Math.max(1, Math.min(20_000, deadline - Date.now()));
    try {
      for (const entry of this.store.interrupted()) {
        if (Date.now() >= deadline || !this.gateway.state().accepting) break;
        try {
          if (entry.kind === 'message') {
            if (this.store.get(entry.channelId) && await this.chatThread(entry.channelId, remaining())) {
              await this.rest.message(entry.channelId, recoveryText, entry.id + 'r', remaining(), this.store.get(entry.channelId)?.mode === 'group' ? entry.id : undefined);
            }
          } else if (entry.kind === 'interaction') {
            const saved = entry.createdThreadId && this.store.get(entry.createdThreadId);
            if (entry.createdThreadId && !saved) await this.rest.request('PATCH', `/channels/${entry.createdThreadId}`, { archived: true }, { deadlineMs: remaining() });
            if (entry.token && Date.now() - entry.createdAt < 14 * 60_000) await this.rest.editInteraction(this.config.applicationId, entry.token,
              saved ? `Your conversation is ready: <#${entry.createdThreadId}>` : 'I restarted while running that command. Please try it again.', remaining());
          }
          this.store.finish(entry.id, 'recovered');
        } catch (error) {
          if (error instanceof DiscordError && [400, 401, 403, 404].includes(error.status)) this.store.finish(entry.id, 'failed');
          // Leave transient failures for the next watchdog; never repeat the model call.
        }
      }
    } finally { this.recovering = false; }
  }

  async alarm(): Promise<void> {
    await this.gateway.tick();
    if (this.gateway.ready) this.track(() => this.recover());
    if (this.gateway.ready && this.gateway.state().accepting) this.track(() => this.beta.check(id => allowsGuild(this.config, id), async (guildId, channelId, revisions, checkedAt, nonce) => {
      const channel = await this.rest.request<Channel>('GET', `/channels/${channelId}`);
      if (channel.guild_id !== guildId || ![0, 5].includes(channel.type)) throw new Error('Invalid beta notification channel.');
      await this.rest.richMessage(channelId, latestMessage({ checkedAt, revisions }, revisions), nonce);
    }));
    const lastPrune = this.store.getState<number>('lastPrune') ?? 0;
    if (Date.now() - lastPrune >= 3600_000) {
      this.store.prune();
      this.store.setState('lastPrune', Date.now());
    }
  }

  private health(): Record<string, unknown> {
    const state = this.gateway.state();
    const servers = this.store.betaStates().filter(beta => allowsGuild(this.config, beta.guildId)).map(beta => ({
      guildId: beta.guildId, enabled: Boolean(beta.channelId), lastCheckedAt: beta.lastCheckedAt, lastError: beta.lastError,
    }));
    return { configured: true, running: state.running, accepting: state.accepting, ready: this.gateway.ready,
      blocked: state.blocked, lastAckAt: this.gateway.lastAckAt, heartbeatMs: this.gateway.latency,
      connections: state.connections, nextConnectAt: state.nextConnectAt,
      lastDisconnect: state.lastDisconnect ?? null, lastOpcode: this.gateway.lastOpcode, lastEvent: this.gateway.lastEvent,
      active: this.active.size, sessions: this.store.sessionCount(), journal: this.store.counts(),
      lastFailure: this.store.getState('lastFailure') ?? null,
      lore: loreCatalogueInfo,
      serverAccess: { mode: this.config.guildIds === null ? 'all-installed' : 'allowlist', guildIds: this.config.guildIds ?? null },
      betaAlerts: { enabled: servers.some(server => server.enabled), lastCheckedAt: Math.max(0, ...servers.map(server => server.lastCheckedAt ?? 0)) || null,
        lastError: servers.find(server => server.lastError)?.lastError ?? null, servers } };
  }

  private async verifyProviders(): Promise<Response> {
    // Fixed synthetic inputs only: this never reads chats or posts a Discord message.
    // This is an explicit admin action because it uses the providers' normal billing.
    if (this.active.size) return new Response('Wait for active work to finish before verification.', { status: 409 });
    const result: Record<string, 'ok' | 'disabled' | 'failed'> = { ai: 'disabled', web: 'disabled' };
    const operation = (async (): Promise<void> => {
      const checks: Promise<void>[] = [];
      if (this.config.ai) {
        const provider = new OpenAICompatibleProvider({ ...this.config.ai,
          systemPrompt: 'This is a connection check. Reply only with OK.', maxOutputTokens: 128 });
        checks.push(provider.reply([{ role: 'user', content: 'Reply with OK.' }]).then(
          () => { result.ai = 'ok'; }, () => { result.ai = 'failed'; }));
      }
      if (this.config.web) {
        const provider = new DeepSeekWebProvider(this.config.web);
        checks.push(provider.search('Cloudflare Workers documentation', AbortSignal.timeout(15_000)).then(
          () => { result.web = 'ok'; }, () => { result.web = 'failed'; }));
      }
      await Promise.all(checks);
    })();
    this.active.add(operation);
    this.ctx.waitUntil(operation);
    try { await operation; return Response.json(result, { status: Object.values(result).includes('failed') ? 503 : 200 }); }
    finally { this.active.delete(operation); }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/status') return Response.json(this.health());
    if (request.method === 'GET' && path === '/history') {
      if (this.active.size || this.gateway.state().running) return new Response('Drain the bot before exporting history.', { status: 409 });
      return Response.json(this.store.exportHistory());
    }
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (path === '/beta/verify') {
      try { return Response.json({ ok: true, ...await this.beta.client.verify(), alertsEnabled: this.store.betaStates().some(state => allowsGuild(this.config, state.guildId) && Boolean(state.channelId)) }); }
      catch { return Response.json({ ok: false, error: 'Gachabase could not be read from the hosted runtime.' }, { status: 502 }); }
    }
    if (path === '/verify') return this.verifyProviders();
    if (path === '/start') {
      if (this.draining) return new Response('A drain is still running.', { status: 409 });
      this.chat?.resumeReplies();
      await this.gateway.start();
    } else if (path === '/stop') { this.chat?.cancelQueuedReplies(); await this.gateway.stop(); }
    else if (path === '/drain') {
      this.gateway.patch({ accepting: false });
      this.chat?.cancelQueuedReplies();
      this.draining ??= Promise.allSettled([...this.active]).then(async () => { await this.gateway.stop(); });
      try { await this.draining; } finally { this.draining = null; }
    } else if (path === '/history/import') {
      if (this.active.size || this.gateway.state().running) return new Response('Drain the bot before importing history.', { status: 409 });
      try {
        const reader = request.body?.getReader();
        if (!reader) throw new Error('A history file is required.');
        const decoder = new TextDecoder();
        let bytes = 0, text = '';
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 16 * 1024 * 1024) throw new Error('History exceeds the 16 MiB import limit.');
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return Response.json({ imported: this.store.importHistory(JSON.parse(text)) });
      }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Invalid history.' }, { status: 400 }); }
    } else return new Response('Not found', { status: 404 });
    return Response.json(this.health());
  }
}
