import { spoilerDelimiters } from './spoilers.ts';

// Discord counts UTF-16 code units. Each message must contain complete spoiler spans.
function splitText(text: string, limit: number, preferNewlines: boolean): string[] {
  const chunks: string[] = [];
  const delimiters = spoilerDelimiters(text);
  let offset = 0, token = 0, hidden = false;
  while (offset < text.length) {
    const prefix = hidden ? '||' : '';
    const finalHidden = (delimiters.length - token) % 2 ? !hidden : hidden;
    let end = text.length;
    if (end - offset + prefix.length + (finalHidden ? 2 : 0) > limit) {
      // Reserve room to close a span, including a span opened in the selected text.
      end = offset + limit - prefix.length - (delimiters.length ? 2 : 0);
      if (preferNewlines) {
        const newline = text.lastIndexOf('\n', end - 1);
        if (newline >= offset + limit / 2) end = newline + 1;
      }
      if (delimiters.includes(end - 1)) end--; // Never split the two pipes.
      const lastCodeUnit = text.charCodeAt(end - 1);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
    }
    const start = offset;
    let nextToken = token;
    let nextHidden: boolean = hidden;
    while (nextToken < delimiters.length && delimiters[nextToken]! < end) { nextHidden = !nextHidden; nextToken++; }
    // Leave an opening marker with its content, rather than creating an empty |||| at a cut.
    if (end < text.length && end - start > 2 && nextHidden && delimiters[nextToken - 1] === end - 2) {
      end -= 2; nextHidden = false; nextToken--;
    }
    // The reserved closing space can hold the original closing marker instead.
    if (nextHidden && delimiters[nextToken] === end && end - start + prefix.length + 2 <= limit) {
      end += 2; nextHidden = false; nextToken++;
    }
    hidden = nextHidden; token = nextToken;
    chunks.push(prefix + text.slice(start, end) + (hidden ? '||' : ''));
    offset = end;
  }
  return chunks;
}

export function splitDiscordMessage(text: string): string[] { return splitText(text, 2_000, true); }

export function truncateDiscordText(text: string, limit: number, suffix: string): string {
  if (text.length <= limit) return text;
  return splitText(text, limit - suffix.length, false)[0]! + suffix;
}
