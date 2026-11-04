export async function upgradeWebSocket(url: URL | string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('WebSocket handshake timed out.')), timeoutMs);
  try {
    return await fetch(url, { headers: { Upgrade: 'websocket' }, redirect: 'manual', signal: controller.signal });
  } finally {
    // Cloudflare keeps the fetch signal attached to the upgraded socket. A lifetime
    // AbortSignal.timeout() would tear down a healthy Gateway after the handshake.
    clearTimeout(timeout);
  }
}
