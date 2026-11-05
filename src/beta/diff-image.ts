import type { BetaDetailEntry } from './types.ts';
import { wordDiff } from './diff.ts';
import type { DiffRun } from './diff.ts';

export const DIFF_IMAGE_WIDTH = 1_000;
const COLUMNS = 58, LINES_PER_SIDE = 12, FONT_SIZE = 26, LINE_HEIGHT = 39;
export const diffColors = { background: '#24262b', text: '#e3e5e8', removed: '#ff8b94', added: '#83e3a4', muted: '#b4bbc6' };
export interface DiffImagePage { svg: string; width: number; height: number; text: string; name: string }
const xml = (value: string): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wrap(runs: DiffRun[]): DiffRun[][] {
  const lines: DiffRun[][] = [[]];
  const groups: DiffRun[][] = [];
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
    if (length && length + count > COLUMNS) { lines.push([]); length = 0; }
    if (!length && /^\s+$/u.test(group[0]!.text)) continue;
    for (const run of group) {
      const characters = Array.from(run.text);
      for (let offset = 0; offset < characters.length;) {
        if (length === COLUMNS) { lines.push([]); length = 0; }
        const chunk = characters.slice(offset, offset + COLUMNS - length);
        const text = chunk.join(''); offset += chunk.length;
        lines.at(-1)!.push({ ...run, text }); length += Array.from(text).length;
      }
    }
  }
  return lines;
}

export function diffImagePages(entries: BetaDetailEntry[]): DiffImagePage[] {
  const pages: DiffImagePage[] = [];
  for (const entry of entries) {
    if (!entry.comparison) continue;
    const { before, after } = entry.comparison;
    const diff = wordDiff(before ?? '', after ?? '');
    const oldLines = wrap(before === null ? [{ text: 'Not present', changed: false }] : diff.before);
    const newLines = wrap(after === null ? [{ text: 'Removed', changed: false }] : diff.after);
    const count = Math.max(1, Math.ceil(Math.max(oldLines.length, newLines.length) / LINES_PER_SIDE));
    for (let index = 0; index < count; index++) {
      const oldPage = oldLines.slice(index * LINES_PER_SIDE, (index + 1) * LINES_PER_SIDE);
      const newPage = newLines.slice(index * LINES_PER_SIDE, (index + 1) * LINES_PER_SIDE);
      const titleLines = wrap([{ text: entry.name, changed: false }]);
      const title = titleLines.slice(0, 3);
      if (titleLines.length > 3) title.at(-1)!.push({ text: '…', changed: false });
      let y = 48;
      const body: string[] = [];
      const draw = (lines: DiffRun[][], color: string, removed = false): void => {
        for (const line of lines) {
          body.push(`<text x="36" y="${y}" xml:space="preserve">${line.map(run => `<tspan fill="${run.changed ? color : diffColors.text}"${removed && run.changed ? ' text-decoration="line-through"' : ''}>${xml(run.text)}</tspan>`).join('')}</text>`);
          y += LINE_HEIGHT;
        }
      };
      draw(title, diffColors.text); y += 26;
      if (count > 1) { body.push(`<text x="36" y="${y}" fill="${diffColors.muted}" font-size="20">Continuation ${index + 1}/${count}</text>`); y += 38; }
      draw(oldPage.length ? oldPage : [[{ text: '(Earlier text shown on previous page)', changed: false }]], diffColors.removed, true);
      y += 12;
      // Draw the arrow as a vector so it never depends on a font glyph.
      body.push(`<path d="M500 ${y} v28 m-10 -10 l10 10 l10 -10" stroke="${diffColors.muted}" stroke-width="3" fill="none"/>`);
      y += 76;
      draw(newPage.length ? newPage : [[{ text: '(Earlier text shown on previous page)', changed: false }]], diffColors.added);
      y += 24;
      body.push(`<text x="36" y="${y}" font-size="19"><tspan fill="${diffColors.removed}">− Removed</tspan><tspan fill="${diffColors.muted}">   →   </tspan><tspan fill="${diffColors.added}">+ Added</tspan></text>`);
      const height = y + 34;
      const plain = (lines: DiffRun[][]): string => lines.map(line => line.map(run => run.text).join('')).join('\n');
      const text = `${entry.name}\n${plain(oldPage)}\n↓\n${plain(newPage)}`;
      pages.push({ width: DIFF_IMAGE_WIDTH, height, name: entry.name, text,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${DIFF_IMAGE_WIDTH}" height="${height}" viewBox="0 0 ${DIFF_IMAGE_WIDTH} ${height}"><rect width="100%" height="100%" rx="12" fill="${diffColors.background}"/><g font-family="Noto Sans Mono" font-size="${FONT_SIZE}" font-weight="400" fill="${diffColors.text}">${body.join('')}</g></svg>` });
    }
  }
  return pages;
}
