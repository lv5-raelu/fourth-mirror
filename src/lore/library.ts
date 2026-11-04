import type { LoreEntry, LoreSpoiler } from './types.ts';

export const MAX_LORE_CHARACTERS = 8_000;
export const MAX_LORE_ENTRIES = 5;
const ambiguous = new Set(['path', 'paths', 'harmony', 'hunt', 'abundance', 'preservation', 'destruction', 'erudition', 'nihility', 'remembrance', 'order', 'credits', 'credit', 'family', 'the family', 'curio', 'curios']);
const ignored = new Set('a an the of and or to for in on at is are was were be it its what who why how does do can could would should tell me about explain please lore culture cultural setting'.split(' '));
const categoryTerms = {
  cosmology: ['cosmology', 'aeons', 'paths', 'path'], person: ['characters', 'people'], faction: ['factions', 'organizations', 'organisations', 'guilds'],
  location: ['locations', 'places', 'worlds', 'planets'], lifeform: ['lifeforms', 'lifeform', 'species', 'races'],
  culture: ['culture', 'cultures', 'customs', 'traditions', 'food'], technology: ['technology', 'technologies', 'inventions'], history: ['history', 'history books'],
} as const;

function normalize(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function contains(text: string, phrase: string): boolean { return (' ' + text + ' ').includes(' ' + phrase + ' '); }

/** Permission comes from the current question only, never history or a tool-generated query. */
export function allowsStorySpoilers(question: string): boolean {
  const direct = question.replace(/```[\s\S]*?```/g, ' ').replace(/^\s*>.*$/gm, ' ').replace(/"(?:\\.|[^"\\])*"|“[^”]*”|‘[^’]*’|(?<![\p{L}\p{N}])'[^'\r\n]*'(?![\p{L}\p{N}])/gu, ' ');
  const text = normalize(direct).slice(0, 4_000);
  if (/\b(?:no (?:plot |story |major |ending )?spoilers?|spoiler free|without (?:any )?spoilers?|avoid (?:plot |story )?spoilers?|don t spoil|do not spoil|(?:don t|do not|never) (?:include|allow|give|show|reveal) (?:any |plot |story )*spoilers?)\b/.test(text)) return false;
  return /\b(?:spoilers? (?:are )?(?:ok|okay|allowed|fine|welcome)|(?:include|allow) (?:the |all )?(?:plot |story )?spoilers?|spoil (?:it|everything|the story|the ending|the plot))\b/.test(text);
}

export class LoreLibrary {
  readonly entries: readonly LoreEntry[];
  readonly #indexed: { entry: LoreEntry; aliases: string[]; words: Set<string> }[];

  constructor(entries: readonly LoreEntry[]) {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || ids.has(entry.id) || !entry.title.trim() || entry.title.length > 100 ||
        !entry.content.trim() || entry.content.length > 1_800 || !entry.aliases.length || entry.aliases.some(alias => !alias.trim() || alias.length > 100) ||
        !/^\d+\.\d+(?:\.\d+)?$/.test(entry.release) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewedAt) || !Number.isFinite(Date.parse(entry.reviewedAt)) ||
        !entry.sources.length || entry.sources.some(source => {
          try { const url = new URL(source.url); return !source.title.trim() || url.protocol !== 'https:' || Boolean(url.username || url.password) || /[\r\n]/.test(source.url); }
          catch { return true; }
        })) throw new Error('Invalid lore catalogue entry: ' + entry.id);
      ids.add(entry.id);
    }
    for (const entry of entries) if (entry.related.some(id => !ids.has(id))) throw new Error('Unknown related lore entry: ' + entry.id);
    this.entries = entries;
    this.#indexed = entries.map(entry => ({ entry, aliases: [...new Set([entry.title, ...entry.aliases].map(normalize))],
      words: new Set(normalize(entry.title + ' ' + entry.aliases.join(' ') + ' ' + entry.content).split(' ')),
    }));
  }

  search(query: string, spoiler: LoreSpoiler = 'setting', scope: 'automatic' | 'catalogue' = 'automatic'): readonly LoreEntry[] {
    if (!query.trim() || query.length > 500) return [];
    const text = normalize(query);
    const explicit = /\b(?:hsr|honkai star rail|star rail)\b/.test(text);
    const eligible = this.#indexed.filter(({ entry }) => ['released', 'in-universe-account'].includes(entry.status) && (spoiler === 'story' || entry.spoiler === 'setting'));
    // Ambiguous everyday words such as "path" and "credits" must not hijack unrelated questions.
    const specific = eligible.filter(({ aliases }) => aliases.some(alias => !ambiguous.has(alias) && contains(text, alias)));
    const related = new Set(specific.flatMap(({ entry }) => entry.related));
    const categoryQuery = text.replace(/\b(?:hsr|honkai|star|rail|the|in|of|and)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const broad = Object.values(categoryTerms).some(terms => terms.some(term => term === categoryQuery)) ||
      /\b(?:list|overview|what species|which species|what lifeforms|which lifeforms|what factions|which factions|kinds of|types of)\b/.test(text) ||
      /^(?:tell me about|explain|describe) (?:the )?(?:different |main |major )?(?:species|lifeforms|factions|cultures|worlds|technology|cosmology)\b/.test(text);
    const anchored = scope === 'catalogue' || explicit || specific.length > 0;
    if (!anchored) return [];
    const terms = [...new Set(text.split(' ').filter(term => term.length > 2 && !ignored.has(term)))];
    const ranked = eligible.map(({ entry, aliases, words }) => {
      const exact = aliases.filter(alias => contains(text, alias));
      const category = ((!specific.length && broad) || related.has(entry.id)) && categoryTerms[entry.category].some(term => contains(text, term)) ? 6 : 0;
      const score = category + exact.reduce((total, alias) => total + (ambiguous.has(alias) ? 4 : 25) + alias.split(' ').length, 0) +
        terms.reduce((total, term) => total + (words.has(term) ? 1 : 0), 0);
      return { entry, score, exact: exact.length };
    }).filter(row => row.exact > 0 || row.score >= 3).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    const found: LoreEntry[] = [];
    let used = 0;
    for (const { entry } of ranked) {
      const size = JSON.stringify(entry).length + 60;
      if (used + size > MAX_LORE_CHARACTERS) continue;
      found.push(entry); used += size;
      if (found.length === MAX_LORE_ENTRIES) break;
    }
    return found;
  }
}
