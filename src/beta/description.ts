import { plainText } from './text.ts';
import type { BetaTextRange } from './types.ts';

/** Preserve GachaBase's amber colour tags and automatically highlighted tooltip values. */
export function formatDescription(value: unknown, parameters: unknown): { text: string; emphasis: BetaTextRange[] } {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const raw = typeof value === 'string' ? value : typeof item.override === 'string' && item.override ? item.override : typeof item.text === 'string' ? item.text : '';
  const params = Array.isArray(parameters) ? parameters.slice(0, 150) : [];
  const sourceEmphasis: BetaTextRange[] = [], colors: boolean[] = [];
  let source = '', offset = 0;
  const append = (value: string): void => {
    const part = plainText(value, false), start = source.length;
    source += part;
    if (colors.at(-1) && part) {
      const previous = sourceEmphasis.at(-1);
      if (previous?.end === start) previous.end = source.length;
      else sourceEmphasis.push({ start, end: source.length });
    }
  };
  for (const match of raw.matchAll(/<\/?[a-z][^>]*>/gi)) {
    append(raw.slice(offset, match.index));
    const tag = match[0];
    if (/^<br\s*\/?\s*>$/i.test(tag)) append('\n');
    else if (/^<color\b/i.test(tag)) colors.push(/^<color\s*=\s*["']?(?:#(?:f29e38|fcbd5b)(?:[a-f0-9]{2})?|orange)["']?\s*>$/i.test(tag));
    else if (/^<\/color\s*>$/i.test(tag)) colors.pop();
    offset = match.index + tag.length;
  }
  append(raw.slice(offset));

  // Resolve after removing tags so a unit outside </unbreak> or </color> still
  // belongs to its parameter. Rebase source emphasis onto the expanded text.
  const emphasis: BetaTextRange[] = [];
  let text = '', rangeIndex = 0;
  const highlight = (start: number, end: number): void => {
    const previous = emphasis.at(-1);
    if (previous?.end === start) previous.end = end;
    else emphasis.push({ start, end });
  };
  const copy = (start: number, end: number): void => {
    if (end <= start) return;
    const base = text.length;
    text += source.slice(start, end);
    while (sourceEmphasis[rangeIndex] && sourceEmphasis[rangeIndex]!.end <= start) rangeIndex++;
    for (let index = rangeIndex; sourceEmphasis[index] && sourceEmphasis[index]!.start < end; index++) {
      const range = sourceEmphasis[index]!;
      highlight(base + Math.max(start, range.start) - start, base + Math.min(end, range.end) - start);
    }
  };
  offset = 0;
  for (const match of source.matchAll(/#(\d+)\[(?:i|f\d+)\](%?)/g)) {
    copy(offset, match.index);
    const [, index, percent] = match;
    // GachaBase parameter indices are zero-based, while placeholders are one-based.
    const values = params.find(param => param && typeof param === 'object' && param.index === Number(index) - 1)?.values;
    const number = Array.isArray(values) ? values[0] : undefined, start = text.length;
    if (typeof number === 'number' && Number.isFinite(number)) {
      text += String(Number((number * (percent ? 100 : 1)).toFixed(4))) + percent;
      highlight(start, text.length);
    } else text += `[parameter ${index} unavailable]`;
    offset = match.index + match[0].length;
  }
  copy(offset, source.length);
  const leading = text.length - text.trimStart().length;
  text = text.trim();
  return { text, emphasis: emphasis.map(range => ({ start: Math.max(0, range.start - leading), end: Math.min(text.length, range.end - leading) }))
    .filter(range => range.end > range.start) };
}
