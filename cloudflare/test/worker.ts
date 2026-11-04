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
      for (const state of this.store.betaStates()) this.store.saveBetaState({ ...state, nextCheckAt: 0 });
      await this.alarm();
      return Response.json({ ok: true });
    }
    if (path === '/__beta_legacy') {
      const state = await request.json() as { guildId: string };
      this.store.sql.exec('DELETE FROM beta_alerts WHERE guild_id = ?', state.guildId);
      this.store.setState('betaAlerts', state);
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
export default worker;
