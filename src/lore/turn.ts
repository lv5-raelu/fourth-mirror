import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { requestsSpoilerFreeAnswer, LoreLibrary, MAX_LORE_CHARACTERS } from './library.ts';
import type { LoreEntry } from './types.ts';
import { hideSpoilerText, spoilerSpans } from '../chat/spoilers.ts';
import { literalJson, renderSourceMarkers, requestsLoreSources, sourceLinksToMarkers } from '../chat/citations.ts';

export const loreToolDefinition: ChatCompletionTool = { type: 'function', function: {
  name: 'lore_search',
  description: 'Search the curated English Honkai: Star Rail library for worlds, cultures, food, lifeforms, political institutions, characters, technology, and history. Free local lookup; use for established lore and relevant concept connections before web search when context is missing. Coverage is selected, not exhaustive or live. Story entries are available by default: hide plot revelations with Discord spoiler tags. An explicit spoiler-free question filters them out.',
  parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 240 } }, required: ['query'], additionalProperties: false },
} };

export class LoreTurn {
  readonly #library: LoreLibrary;
  readonly #story: boolean;
  readonly #showSources: boolean;
  readonly #sources = new Map<string, { marker: string; entry: LoreEntry }>();
  readonly #cache = new Map<string, string>();
  #calls = 0;
  #characters = 0;

  constructor(library: LoreLibrary, question: string) {
    this.#library = library;
    this.#story = !requestsSpoilerFreeAnswer(question);
    this.#showSources = requestsLoreSources(question);
  }

  initial(question: string): string | undefined {
    const entries = this.#library.search(question.slice(0, 500), this.#story ? 'story' : 'setting');
    if (entries.length || /\b(?:hsr|honkai\s*:?\s*star\s+rail|star\s+rail)\b/i.test(question)) return this.#encode(entries);
    const connection = this.#library.connection(question);
    return connection ? this.#encode(connection.entries, { concept: connection.concept, comparison: connection.comparison }) : undefined;
  }

  run(argumentsJson: string): string {
    if (argumentsJson.length > 2_000) return JSON.stringify({ error: 'Lore query is too long.' });
    try {
      const args: unknown = JSON.parse(argumentsJson);
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'query') ||
        !('query' in args) || typeof args.query !== 'string' || !args.query.trim() || [...args.query].length > 240) {
        return JSON.stringify({ error: 'Supply only a query containing 1 to 240 characters.' });
      }
      const cached = this.#cache.get(args.query);
      if (cached) return cached;
      if (this.#calls >= 6 || this.#characters >= MAX_LORE_CHARACTERS * 2) return JSON.stringify({ error: 'Lore lookup budget reached. Use the references already supplied.' });
      this.#calls++;
      const result = this.#encode(this.#library.search(args.query, this.#story ? 'story' : 'setting', 'catalogue'));
      this.#cache.set(args.query, result);
      return result;
    } catch { return JSON.stringify({ error: 'Invalid lore query JSON.' }); }
  }

  #encode(entries: readonly LoreEntry[], connection?: { concept: string; comparison: string }): string {
    const selected: { source_id: string; entry: LoreEntry }[] = [];
    for (const entry of entries) {
      if (this.#characters + JSON.stringify(entry).length + 60 > MAX_LORE_CHARACTERS * 2) break;
      let source = this.#sources.get(entry.id);
      if (!source) { source = { marker: 'L' + (this.#sources.size + 1), entry }; this.#sources.set(entry.id, source); }
      selected.push({ source_id: source.marker, entry });
      this.#characters += JSON.stringify(entry).length + 60;
    }
    return JSON.stringify({ coverage: 'Curated released lore; not an exhaustive or current-patch database. Release labels identify the material summarized. Review dates do not mean live verification.',
      spoiler_policy: this.#story ? 'Answer normally. Hide every plot revelation, including revealing source links, inside Discord ||spoiler tags||. No opt-in phrase is needed. Keep ordinary setting/culture visible.' : 'The current question explicitly requests a spoiler-free answer. Setting and culture only; omit plot revelations instead of putting them behind tags.',
      entries: selected,
      ...(connection ? { connection } : {}),
    });
  }

  renderCitations(answer: string): string {
    if (!this.#sources.size) return answer;
    // Citation-shaped strings can be the exact data/code the user requested.
    if (literalJson(answer)) return answer;
    const references = new Map([...this.#sources.values()].map(source => [source.marker, source.entry.sources]));
    answer = sourceLinksToMarkers(answer, references);
    answer = this.#hideStoryParagraphs(answer);
    // If story reference material was supplied but the model omitted tags and usable citations,
    // conceal its prose conservatively, including uncited paraphrases and requests to remove tags.
    if ([...this.#sources.values()].some(source => source.entry.spoiler === 'story') && !spoilerSpans(answer).length &&
      !/```/.test(answer)) answer = hideSpoilerText(answer);
    return renderSourceMarkers(answer, 'L', references, this.#showSources);
  }

  #hideStoryParagraphs(answer: string): string {
    const spans = spoilerSpans(answer);
    const ranges: { start: number; end: number }[] = [];
    // A story citation classifies its whole paragraph, even if only the citation or last clause
    // was tagged. Otherwise an analogy can reveal the same twist outside that small span.
    const tokens = /```[\s\S]*?(?:```|$)|`[^`\r\n]*`|\\[\s\S]|\[L(\d+)\](?:\([^\r\n)]*\))?/g;
    for (const match of answer.matchAll(tokens)) {
      if (!match[1] || ![...this.#sources.values()].some(source => source.marker === 'L' + match[1] && source.entry.spoiler === 'story')) continue;
      let start = answer.lastIndexOf('\n\n', match.index);
      start = start === -1 ? 0 : start + 2;
      let end = answer.indexOf('\n\n', match.index);
      if (end === -1) end = answer.length;
      for (const span of spans) {
        if (span.start < end && span.end > start) { start = Math.min(start, span.start); end = Math.max(end, span.end); }
      }
      const previous = ranges.at(-1);
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else ranges.push({ start, end });
    }
    for (const range of ranges.reverse()) answer = answer.slice(0, range.start) + hideSpoilerText(answer.slice(range.start, range.end)) + answer.slice(range.end);
    return answer;
  }
}
