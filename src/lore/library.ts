import type { LoreEntry, LoreSpoiler } from './types.ts';
import type { LoreConnection } from './connections.ts';

export const MAX_LORE_CHARACTERS = 8_000;
export const MAX_LORE_ENTRIES = 5;
const ambiguous = new Set(['path', 'paths', 'harmony', 'hunt', 'abundance', 'preservation', 'destruction', 'erudition', 'nihility', 'remembrance', 'order', 'credits', 'credit', 'family', 'the family', 'curio', 'curios',
  'sunday', 'robin', 'jade', 'blade', 'sparkle', 'cipher', 'march 7', 'march 7th', 'golden hour', 'dreamscape', 'titans', 'janus', 'wildfire', 'propagation', 'ix', 'chimera', 'chimeras', 'dreamers']);
const ignored = new Set('a an the of and or to for in on at is are was were be it its what who why how does do can could would should tell me about explain please lore culture cultural setting hsr honkai star rail'.split(' '));
const categoryTerms = {
  cosmology: ['cosmology', 'aeons', 'paths', 'path'], person: ['characters', 'people', 'figures'], faction: ['factions', 'organizations', 'organisations', 'guilds', 'politics', 'government', 'governance', 'governs', 'governed', 'institutions'],
  location: ['locations', 'places', 'worlds', 'planets'], lifeform: ['lifeforms', 'lifeform', 'species', 'races'],
  culture: ['culture', 'cultures', 'customs', 'traditions', 'food', 'foods', 'cuisine', 'drinks', 'eat', 'eating', 'cooking', 'drink', 'drinking'], technology: ['technology', 'technologies', 'inventions'], history: ['history', 'history books', 'historical events', 'events'],
} as const;

function normalize(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function contains(text: string, phrase: string): boolean { return (' ' + text + ' ').includes(' ' + phrase + ' '); }

function directQuestion(question: string): string {
  return question.replace(/```[\s\S]*?(?:```|$)|`[^`\r\n]*`/g, ' ').replace(/^\s*>.*$/gm, ' ').replace(/"(?:\\.|[^"\\])*"|“[^”]*”|‘[^’]*’|(?<![\p{L}\p{N}])'[^'\r\n]*'(?![\p{L}\p{N}])/gu, ' ');
}

/** Everyday keywords alone are not a request for an injected game comparison. */
export function requestsLoreConnection(question: string): boolean {
  const text = normalize(directQuestion(question)).slice(0, 4_000);
  if (/\b(?:do not|don t|never|stop|avoid|skip|omit|tone down|cut back on)\b(?: \w+){0,6} (?:analogies|analogy|metaphors?|comparisons?|connections?)\b/.test(text)) return false;
  return (/\b(?:hsr|honkai star rail|star rail)\b/.test(text) &&
    /\b(?:analogy|analogies|metaphor|metaphors|compare|comparison|parallel|parallels|connection|connections|equivalent|relate)\b/.test(text)) ||
    /\b(?:give|use|using|with|draw|suggest|make|provide|show|offer) (?:(?:me|us|an?|the|simple|brief|helpful|clear|everyday|good) ){0,4}(?:analogy|metaphor)\b/.test(text);
}

/** Honor an explicit spoiler-free request in the current question, not quoted/background text. */
export function requestsSpoilerFreeAnswer(question: string): boolean {
  const text = normalize(directQuestion(question)).slice(0, 4_000);
  return /\b(?:no (?:plot |story |major |ending )?spoilers?|spoiler free|without (?:any )?spoilers?|avoid (?:plot |story )?spoilers?|don t spoil|do not spoil|(?:don t|do not|never) (?:include|allow|give|show|reveal) (?:any |plot |story )*spoilers?)\b/.test(text);
}

export class LoreLibrary {
  readonly entries: readonly LoreEntry[];
  readonly #indexed: { entry: LoreEntry; aliases: string[]; words: Set<string> }[];
  readonly #connections: readonly LoreConnection[];

  constructor(entries: readonly LoreEntry[], connections: readonly LoreConnection[] = []) {
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
    const connectionIds = new Set<string>();
    for (const connection of connections) {
      if (!connection.id || connectionIds.has(connection.id) || !connection.phrases.length || connection.phrases.some(phrase => !normalize(phrase)) ||
        !connection.comparison.trim() || !connection.entryIds.length || connection.entryIds.some(id => !entries.some(entry => entry.id === id && entry.spoiler === 'setting' && entry.status === 'released'))) {
        throw new Error('Invalid lore connection: ' + connection.id);
      }
      connectionIds.add(connection.id);
    }
    this.entries = entries;
    this.#connections = connections;
    this.#indexed = entries.map(entry => ({ entry, aliases: [...new Set([entry.title, ...entry.aliases].map(normalize))],
      words: new Set(normalize(entry.title + ' ' + entry.aliases.join(' ') + ' ' + entry.content).split(' ')),
    }));
  }

  /** Suggest one bounded, spoiler-free connection without changing ordinary lore search semantics. */
  connection(question: string): { comparison: string; concept: string; entries: readonly LoreEntry[] } | undefined {
    const text = normalize(directQuestion(question)).slice(0, 4_000);
    // Optional flavor must yield to an explicit opt-out, exact data output, or sensitive personal context.
    if (/\b(?:no|without|avoid|skip|omit) (?:any )?(?:(?:hsr|star rail|game|lore) )?(?:references|analogies|comparisons|connections)\b|\b(?:don t|do not|stop) (?:mention|mentioning|reference|referencing|bring up|bringing up) (?:hsr|star rail|the game)\b/.test(text) ||
      /\b(?:only|just) (?:the )?(?:code|json|csv|xml|yaml|sql|number|answer)\b|\b(?:code|json|csv|xml|yaml|sql) only\b/.test(text) ||
      /\b(?:grief|grieving|bereavement|suicidal|suicide|self harm|racism|discrimination|harassment|abuse|panic attack|depressed|depression|trauma)\b|\b(?:died|dying|assaulted|overwhelmed)\b/.test(text)) return undefined;
    const matches = this.#connections.flatMap(connection => connection.phrases
      .filter(phrase => contains(text, normalize(phrase))).map(phrase => ({ connection, phrase }))
    ).sort((a, b) => b.phrase.length - a.phrase.length);
    const match = matches[0];
    if (!match) return undefined;
    const entries: LoreEntry[] = [];
    let used = 0;
    for (const id of match.connection.entryIds) {
      const entry = this.entries.find(entry => entry.id === id)!;
      const size = JSON.stringify(entry).length + 60;
      if (used + size > 3_000) continue;
      entries.push(entry); used += size;
      if (entries.length === 2) break;
    }
    return entries.length ? { comparison: match.connection.comparison, concept: match.phrase, entries } : undefined;
  }

  search(query: string, spoiler: LoreSpoiler = 'story', scope: 'automatic' | 'catalogue' = 'automatic'): readonly LoreEntry[] {
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
      /^(?:tell me about|explain|describe) (?:the )?(?:different |main |major |important )?(?:species|lifeforms|factions|cultures|worlds|technology|cosmology|characters|history|politics)\b/.test(text) ||
      /\b(?:main|major|important|key|famous) (?:characters|people|figures|events|locations|worlds|cultures|factions)\b/.test(text);
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
