import { ChatError } from '../chat/types.ts';
import { sharedMessage } from './browser.ts';
import type { BetaMessage } from './types.ts';

export const DIFF_FILENAME = 'beta-diff.png';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Ephemeral attachments must be uploaded again to become permanent channel files. */
export async function prepareSharedMessage(message: BetaMessage, request: typeof fetch = fetch): Promise<BetaMessage> {
  const payload = sharedMessage(message);
  const image = payload.embeds.find(embed => embed.image)?.image;
  if (!image) return payload;
  try {
    const url = new URL(image.url);
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.discordapp.com' || url.port || url.username || url.password ||
      !/^\/(?:ephemeral-attachments|attachments)\/\d+\/\d+\/beta-diff\.png$/.test(url.pathname)) throw new Error('Invalid comparison attachment.');
    const response = await request(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Attachment unavailable.'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.length; if (length > MAX_IMAGE_BYTES) throw new Error('Attachment too large.');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const data = new Uint8Array(length);
    let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    if ([137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => data[index] !== value)) throw new Error('Invalid PNG.');
    return { ...payload, embeds: payload.embeds.map(embed => embed.image ? { ...embed, image: { url: `attachment://${DIFF_FILENAME}` } } : embed),
      files: [{ name: DIFF_FILENAME, data, description: 'The exact beta comparison page shared from the private view.' }] };
  } catch { throw new ChatError('I couldn’t copy this comparison image. Open the page again and try sharing it once more.'); }
}
