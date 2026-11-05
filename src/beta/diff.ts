import { diffArrays } from 'diff';

export interface DiffRun { text: string; changed: boolean }
export interface WordDiff { before: DiffRun[]; after: DiffRun[] }

// Numbers include decimal/grouping separators and percentage units. Apostrophes
// and hyphens stay inside words, so edits never colour half of a word or value.
export function diffTokens(text: string): string[] {
  return text.match(/[+\u2212-]?\d+(?:[.,]\d+)*(?:[%‰])?|[\p{L}\p{M}\p{N}]+(?:['’\u2010\u2011-][\p{L}\p{M}\p{N}]+)*|\s+|[^\s]/gu) ?? [];
}

export function wordDiff(before: string, after: string): WordDiff {
  // Myers' diff keeps long, mostly unchanged paragraphs linear in the number
  // of edits. An extreme rewrite falls back to the selectable text view.
  const parts = diffArrays(diffTokens(before), diffTokens(after), { maxEditLength: 512, timeout: 100 });
  if (!parts) throw new Error('Comparison exceeds the highlighting work limit.');
  const result: WordDiff = { before: [], after: [] };
  for (const part of parts) {
    for (const text of part.value) {
      if (!part.added) result.before.push({ text, changed: Boolean(part.removed) && /\S/u.test(text) });
      if (!part.removed) result.after.push({ text, changed: Boolean(part.added) && /\S/u.test(text) });
    }
  }
  return result;
}
