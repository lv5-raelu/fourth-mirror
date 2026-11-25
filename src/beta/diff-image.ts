import type { BetaDetailEntry, BetaTextRange } from './types.ts';
import { wordDiff } from './diff.ts';
import type { DiffRun } from './diff.ts';
import { isBetaIconUrl } from './icons.ts';

export const DIFF_IMAGE_WIDTH = 1_000;
export const MAX_DIFF_IMAGE_HEIGHT = 8_192;
const COLUMNS = 58, FONT_SIZE = 26, MIN_FONT_SIZE = 16, LINE_HEIGHT = 39, FOOTER_HEIGHT = 58;
export const diffColors = { background: '#24262b', text: '#e3e5e8', emphasis: '#f29e38', removed: '#ff8b94', added: '#83e3a4', muted: '#b4bbc6' };
export interface DiffImagePage { svg: string; width: number; height: number; text: string; name: string; iconUrl?: string }
const xml = (value: string): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type ImageRun = DiffRun & { emphasis?: boolean };

function emphasize(runs: DiffRun[], ranges: BetaTextRange[] = []): ImageRun[] {
  const result: ImageRun[] = [];
  let offset = 0, index = 0;
  for (const run of runs) {
    let cursor = 0;
    while (cursor < run.text.length) {
      const position = offset + cursor;
      while (ranges[index] && ranges[index]!.end <= position) index++;
      const range = ranges[index], emphasis = Boolean(range && range.start <= position);
      const end = Math.min(run.text.length, range ? (emphasis ? range.end : range.start) - offset : run.text.length);
      result.push({ ...run, text: run.text.slice(cursor, end), emphasis });
      cursor = end;
    }
    offset += run.text.length;
  }
  return result;
}

function span(run: ImageRun, changedColor?: string, removed = false): string {
  const color = run.changed && changedColor ? changedColor : run.emphasis ? diffColors.emphasis : diffColors.text;
  return `<tspan fill="${color}"${removed && run.changed ? ' text-decoration="line-through"' : ''}>${xml(run.text)}</tspan>`;
}

function wrap(runs: ImageRun[], columns = COLUMNS): ImageRun[][] {
  const lines: ImageRun[][] = [[]];
  const groups: ImageRun[][] = [];
  // Keep punctuation attached to its word even when the word and punctuation
  // have different colours. A closing quote must not wrap onto its own line.
  for (const run of runs) for (const part of run.text.split(/(\n|[^\S\n]+)/u)) {
    if (!part) continue;
    const group = groups.at(-1);
    if (/\S/u.test(part) && group && /\S/u.test(group[0]!.text)) group.push({ ...run, text: part });
    else groups.push([{ ...run, text: part }]);
  }
  let length = 0;
  for (const group of groups) {
    if (group[0]!.text === '\n') { lines.push([]); length = 0; continue; }
    const count = group.reduce((sum, run) => sum + Array.from(run.text).length, 0);
    if (length && length + count > columns) { lines.push([]); length = 0; }
    if (!length && /^\s+$/u.test(group[0]!.text)) continue;
    for (const run of group) {
      const characters = Array.from(run.text);
      for (let offset = 0; offset < characters.length;) {
        if (length === columns) { lines.push([]); length = 0; }
        const chunk = characters.slice(offset, offset + columns - length);
        const text = chunk.join(''); offset += chunk.length;
        lines.at(-1)!.push({ ...run, text }); length += Array.from(text).length;
      }
    }
  }
  return lines;
}

function header(entry: BetaDetailEntry): { body: string[]; y: number; iconUrl?: string } {
  const heading = entry.heading ?? { type: '', name: entry.name };
  const titleLines = wrap([{ text: heading.name, changed: false }], 49);
  const title = titleLines.slice(0, 3);
  if (titleLines.length > 3) title.at(-1)!.push({ text: '…', changed: false });
  const iconUrl = isBetaIconUrl(heading.iconUrl) ? heading.iconUrl : undefined;
  const body = ['<rect x="36" y="24" width="100" height="100" rx="18" fill="#323640" stroke="#505563"/>'];
  if (iconUrl) body.push(`<image href="${xml(iconUrl)}" x="44" y="32" width="84" height="84" preserveAspectRatio="xMidYMid meet"/>`);
  else body.push('<path d="M86 55 l17 19 -17 19 -17 -19 Z" fill="none" stroke="#8e96a8" stroke-width="2"/>');
  if (heading.type) body.push(`<text x="164" y="46" font-size="18" fill="#e5a2ba">${xml(heading.type)}</text>`);
  title.forEach((line, index) => body.push(`<text x="164" y="${80 + index * 34}" xml:space="preserve">${line.map(run => xml(run.text)).join('')}</text>`));
  const bottom = Math.max(136, 110 + (title.length - 1) * 34);
  body.push(`<path d="M36 ${bottom} H964" stroke="#424650" stroke-width="1"/>`);
  return { body, y: bottom + 46, ...(iconUrl ? { iconUrl } : {}) };
}

function finish(entry: BetaDetailEntry, body: string[], height: number, text: string, iconUrl?: string): DiffImagePage {
  return { width: DIFF_IMAGE_WIDTH, height, name: entry.name, text, ...(iconUrl ? { iconUrl } : {}),
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${DIFF_IMAGE_WIDTH}" height="${height}" viewBox="0 0 ${DIFF_IMAGE_WIDTH} ${height}"><rect width="100%" height="100%" rx="12" fill="${diffColors.background}"/><g font-family="Noto Sans Mono" font-size="${FONT_SIZE}" font-weight="400" fill="${diffColors.text}">${body.join('')}</g></svg>` };
}

function descriptionLayout(descriptions: ImageRun[][], availableHeight: number) {
  let fontSize = FONT_SIZE, lineHeight = LINE_HEIGHT;
  let lines = descriptions.map(runs => wrap(runs));
  while (fontSize > MIN_FONT_SIZE && lines.reduce((total, side) => total + side.length, 0) * lineHeight > availableHeight) {
    fontSize -= 2;
    lineHeight = fontSize * LINE_HEIGHT / FONT_SIZE;
    lines = descriptions.map(runs => wrap(runs, Math.floor(COLUMNS * FONT_SIZE / fontSize)));
  }
  return { lines, fontSize, lineHeight };
}

function drawLines(body: string[], lines: ImageRun[][], y: number, fontSize: number, lineHeight: number, color?: string, removed = false): number {
  for (const line of lines) {
    body.push(`<text x="36" y="${y}" font-size="${fontSize}" xml:space="preserve">${line.map(run => span(run, color, removed)).join('')}</text>`);
    y += lineHeight;
  }
  return y;
}

const plain = (lines: ImageRun[][]): string => lines.map(line => line.map(run => run.text).join('')).join('\n');

export function diffImagePages(entries: BetaDetailEntry[]): DiffImagePage[] {
  const pages: DiffImagePage[] = [];
  const arrowGap = 88;
  for (const entry of entries) {
    if (!entry.comparison) continue;
    const { before, after, beforeEmphasis, afterEmphasis } = entry.comparison;
    const diff = wordDiff(before ?? '', after ?? '');
    const heading = header(entry), { body } = heading;
    const { lines: [oldLines, newLines], fontSize, lineHeight } = descriptionLayout([
      before === null ? [{ text: 'Not present', changed: false }] : emphasize(diff.before, beforeEmphasis),
      after === null ? [{ text: 'Removed', changed: false }] : emphasize(diff.after, afterEmphasis),
    ], MAX_DIFF_IMAGE_HEIGHT - heading.y - arrowGap - FOOTER_HEIGHT);
    const oldEnd = drawLines(body, oldLines!, heading.y, fontSize, lineHeight, diffColors.removed, true);
    // Draw the arrow as a vector so it never depends on a font glyph.
    body.push(`<path d="M500 ${oldEnd + 12} v28 m-10 -10 l10 10 l10 -10" stroke="${diffColors.muted}" stroke-width="3" fill="none"/>`);
    const newEnd = drawLines(body, newLines!, oldEnd + arrowGap, fontSize, lineHeight, diffColors.added);
    body.push(`<text x="36" y="${newEnd + 24}" font-size="19"><tspan fill="${diffColors.removed}">− Removed</tspan><tspan fill="${diffColors.muted}">   →   </tspan><tspan fill="${diffColors.added}">+ Added</tspan></text>`);
    pages.push(finish(entry, body, newEnd + FOOTER_HEIGHT, `${entry.name}\n${plain(oldLines!)}\n↓\n${plain(newLines!)}`, heading.iconUrl));
  }
  return pages;
}

/** Current kit pages use the same icon header, with one readable ability per page. */
export function currentImagePages(entries: BetaDetailEntry[]): DiffImagePage[] {
  const pages: DiffImagePage[] = [];
  for (const entry of entries) {
    const heading = header(entry), { body } = heading;
    const { lines: [lines], fontSize, lineHeight } = descriptionLayout([
      emphasize([{ text: entry.value, changed: false }], entry.emphasis),
    ], MAX_DIFF_IMAGE_HEIGHT - heading.y - FOOTER_HEIGHT);
    const end = drawLines(body, lines!, heading.y, fontSize, lineHeight);
    body.push(`<text x="36" y="${end + 24}" font-size="19" fill="${diffColors.muted}">Current beta details</text>`);
    pages.push(finish(entry, body, end + FOOTER_HEIGHT, `${entry.name}\n${plain(lines!)}`, heading.iconUrl));
  }
  return pages;
}
