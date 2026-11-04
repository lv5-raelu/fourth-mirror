/** Discord spoiler delimiters outside code and escaped characters. */
export function spoilerDelimiters(text: string): number[] {
  const positions = [...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\r\n]*`|\\[\s\S]|\|\|/g)]
    .filter(match => match[0] === '||').map(match => match.index);
  // A literal pipe value in valid JSON must not gain markup outside its data envelope.
  if (positions.length % 2) {
    try { JSON.parse(text); return []; } catch { /* Prose may have an unfinished spoiler. */ }
  }
  return positions;
}

export function spoilerSpans(text: string): { start: number; end: number }[] {
  const delimiters = spoilerDelimiters(text);
  const spans: { start: number; end: number }[] = [];
  for (let index = 0; index < delimiters.length; index += 2) {
    spans.push({ start: delimiters[index]!, end: delimiters[index + 1] === undefined ? text.length : delimiters[index + 1]! + 2 });
  }
  return spans;
}

export function closeSpoilers(text: string): string {
  return spoilerDelimiters(text).length % 2 ? text + '||' : text;
}

/** Merge existing real spoiler spans, retaining code and escaped literal pipes. */
export function hideSpoilerText(text: string): string {
  let content = text;
  for (const position of spoilerDelimiters(text).reverse()) content = content.slice(0, position) + content.slice(position + 2);
  return content ? '||' + content + '||' : '';
}
