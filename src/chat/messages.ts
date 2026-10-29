// Discord counts UTF-16 code units. Avoid breaking a surrogate pair at the boundary.
export function splitDiscordMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 2_000) {
    const newline = remaining.lastIndexOf('\n', 2_000);
    let end = newline >= 1_000 ? newline + 1 : 2_000;
    if (end > 2_000) end = 2_000;
    const lastCodeUnit = remaining.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
