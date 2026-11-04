// Unauthenticated Discord transport probe. It never identifies a bot or sends a message.
export async function preflight(): Promise<Response> {
  const response = await fetch('https://discord.com/api/v10/gateway', { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  const httpStatus = response.status;
  if (!response.ok) { await response.body?.cancel(); return Response.json({ discordHttp: httpStatus, gatewayHello: false }); }
  await response.body?.cancel();
  const upgrade = await upgradeWebSocket('https://gateway.discord.gg/?v=10&encoding=json', 5_000);
  const socket = upgrade.webSocket;
  if (!socket) { await upgrade.body?.cancel(); return Response.json({ discordHttp: httpStatus, gatewayHello: false }); }
  socket.accept();
  const gatewayHello = await new Promise<boolean>(resolve => {
    const finish = (ok: boolean): void => { clearTimeout(timer); try { socket.close(4000, 'Transport test complete'); } catch { /* Closed. */ } resolve(ok); };
    const timer = setTimeout(() => finish(false), 5_000);
    socket.addEventListener('message', event => {
      try { finish(typeof event.data === 'string' && JSON.parse(event.data).op === 10); }
      catch { finish(false); }
    }, { once: true });
    socket.addEventListener('error', () => finish(false), { once: true });
    socket.addEventListener('close', () => finish(false), { once: true });
  });
  return Response.json({ discordHttp: httpStatus, gatewayHello });
}
import { upgradeWebSocket } from './websocket.ts';
