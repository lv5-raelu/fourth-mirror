// Test-only entry point. Production does not export these controls or accelerated timers.
import worker from '../src/index.ts';
import { DiscordBot as ProductionBot } from '../src/bot.ts';
import type { GatewayTiming } from '../src/gateway.ts';

export class DiscordBot extends ProductionBot {
  protected override timings(): GatewayTiming {
    return { watchdog: 250, identify: 100, reconnect: 30, maxReconnect: 200, hello: 1000, invalidSession: 50 };
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/__crash') this.ctx.abort('Synthetic actor crash.');
    if (path === '/__journal') return Response.json([...this.store.sql.exec('SELECT id, status, data FROM journal')]);
    if (path === '/__history') return Response.json(this.store.exportHistory());
    if (path === '/__beta_due') {
      const state = this.store.getState<Record<string, unknown>>('betaAlerts');
      if (state) this.store.setState('betaAlerts', { ...state, nextCheckAt: 0 });
      await this.alarm();
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
export default worker;
