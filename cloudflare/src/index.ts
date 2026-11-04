import type { Env } from './config.ts';
import { workerConfig } from './config.ts';
import { preflight } from './preflight.ts';
export { DiscordBot } from './bot.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // All endpoints are private control endpoints; no public interaction endpoint is needed.
    if (typeof env.ADMIN_TOKEN !== 'string' || env.ADMIN_TOKEN.trim().length < 32) return new Response('Configure ADMIN_TOKEN.', { status: 503 });
    const expected = new TextEncoder().encode('Bearer ' + env.ADMIN_TOKEN);
    const supplied = new TextEncoder().encode(request.headers.get('Authorization') ?? '');
    if (expected.length !== supplied.length || !crypto.subtle.timingSafeEqual(expected, supplied)) return new Response('Unauthorized', { status: 401 });
    const path = new URL(request.url).pathname;
    if (path !== '/preflight') {
      try { workerConfig(env); }
      catch (error) {
        return Response.json({ configured: false, running: false, accepting: false, ready: false,
          error: error instanceof Error ? error.message : 'Invalid bot configuration.', hint: 'Upload the Worker settings from .env.cloudflare.' },
        { status: request.method === 'GET' && path === '/status' ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
      }
    }
    try {
      const response = request.method === 'GET' && path === '/preflight'
        ? await preflight() : await env.BOT.getByName('bot').fetch(request);
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response('Bot control failed. Check configuration and Worker logs.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
