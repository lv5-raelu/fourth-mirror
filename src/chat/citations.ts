import { spoilerSpans } from './spoilers.ts';

export interface CitationSource { readonly title: string; readonly url: string }
export type CitationSources = ReadonlyMap<string, readonly CitationSource[]>;

export const citationInstructions = 'Link presentation: Sources in lore_context are private grounding, not a requirement to display links. Ordinary conversation, factual lore explanations, jokes, roleplay, crossover hypotheticals, and everyday analogies should normally have no source links. Include lore links when the latest user explicitly requests sources, citations, evidence, resources, or somewhere to read more. A factual detail used to support a joke does not make the joke a research request. Live web verification and beta comparisons can warrant a concise source note for the substantive claim even without a separate resource request. Respect an explicit request for no links. When citations help, place them in a short parenthetical note, for example: The announcement names Friday. (Source: [Official notice](<https://example.com/notice>)). Use supplied source markers for retrieved evidence. Keep labels short and descriptive, use only the most relevant sources, and avoid duplicate links or an unsolicited reading list. Do not paste a linked page title into the sentence as though it were part of the prose. Requested resource lists can use clearly labeled links as their actual content. Preserve exact code, JSON, and literal URL data; keep revealing citations inside spoiler tags.';

function requestText(question: string): string {
  return question.replace(/```[\s\S]*?(?:```|$)|`[^`\r\n]*`/g, ' ').replace(/^\s*>.*$/gm, ' ')
    .replace(/"(?:\\.|[^"\\])*"|“[^”]*”/g, ' ').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ');
}

export function requestsNoLinks(question: string): boolean {
  return /\b(?:no|without|skip|omit|avoid) (?:any |the )?(?:links?|urls?|citations?|sources?|references?)\b|\b(?:dont|do not|stop) (?:include|add|give|show|provide|cite|link)(?:ing)?(?: me)?(?: any| the)? (?:links?|urls?|citations?|sources?|references?)\b/.test(requestText(question));
}

export function requestsLoreSources(question: string): boolean {
  if (requestsNoLinks(question)) return false;
  const text = requestText(question);
  // Resource nouns alone also occur in ordinary lore (energy sources, political resources).
  return /\bcite\b|\b(?:further reading|reading list|read more)\b/.test(text) ||
    /\b(?:include|add|show|give|provide|share|list|need|want|attach|supply|find|recommend|suggest|have)(?: [\w-]+){0,5} (?:sources?|citations?|references?|resources?|links?|urls?|evidence|proof|receipts)\b/.test(text) ||
    /\bwith (?:supporting |your |the )?(?:sources?|citations?|references?|links?|urls?|evidence|proof)\b/.test(text) ||
    /(?:^|[.!?]\s*)(?:and )?(?:sources?|citations?|references?|resources?|links?|urls?|evidence|proof|receipts)(?: please)?[.!?\s]*$/.test(text) ||
    /\b(?:whats|what is|what are|which is|which are) (?:your |the |that )?(?:sources?|evidence|proof)\b|\b(?:sources?|references?) (?:did you use|for (?:that|this|it))\b/.test(text) ||
    /\b(?:what|which) (?:evidence|proof|sources?) (?:supports?|backs?|confirms?|did|do you|are you)\b/.test(text) ||
    /\bwhere (?:can i (?:read|find|learn)|did you (?:read|find|get)|is (?:that|this|it) (?:stated|mentioned|confirmed|written))\b/.test(text);
}

export function literalJson(answer: string): boolean {
  try { JSON.parse(answer); return true; } catch { return false; }
}

function mapProse(answer: string, transform: (prose: string, offset: number) => string): string {
  if (literalJson(answer)) return answer;
  let offset = 0;
  return answer.split(/(```[\s\S]*?(?:```|$)|`[^`\r\n]*`)/g).map((part, index) => {
    const rendered = index % 2 ? part : transform(part, offset);
    offset += part.length;
    return rendered;
  }).join('');
}

function urlKey(value: string): string {
  try { return decodeURIComponent(new URL(value).href).replace(/\/$/, ''); } catch { return value; }
}

/** Models sometimes copy a registered URL instead of its marker. Apply the same policy to both. */
export function sourceLinksToMarkers(answer: string, sources: CitationSources): string {
  const byUrl = new Map<string, string>();
  for (const [marker, references] of sources) for (const reference of references) {
    const key = urlKey(reference.url);
    if (!byUrl.has(key)) byUrl.set(key, marker);
  }
  return mapProse(answer, prose => prose
    .replace(/\[(?:\\.|[^\]\\\r\n])+\]\(<?(https?:\/\/(?:[^\s<>()]|\([^()\s]*\))+?)>?\)/g,
      (original, url: string) => byUrl.has(urlKey(url)) ? '[' + byUrl.get(urlKey(url)) + ']' : original)
    .replace(/<?https?:\/\/[^\s<>]+>?/g, original => {
      const url = original.replace(/^<|>$/g, '');
      const marker = byUrl.get(urlKey(url));
      if (marker) return '[' + marker + ']';
      // Sentence punctuation is not part of a bare URL.
      let trimmed = url;
      while (/[.,;!?)|]$/.test(trimmed)) {
        trimmed = trimmed.slice(0, -1);
        const trimmedMarker = byUrl.get(urlKey(trimmed));
        if (trimmedMarker) return '[' + trimmedMarker + ']' + url.slice(trimmed.length);
      }
      return original;
    }));
}

export function sourceNote(references: readonly CitationSource[]): string {
  const unique = [...new Map(references.map(source => [urlKey(source.url), source])).values()].slice(0, 3);
  const links = unique.map(source => {
    const title = source.title.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 80).replace(/[\\\[\]`*_~|<>]/g, '\\$&');
    const url = source.url.replace(/[()|<>]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
    return `[${title}](<${url}>)`;
  });
  return links.length ? `(${links.length === 1 ? 'Source' : 'Sources'}: ${links.join('; ')})` : '';
}

/** Group adjacent markers into a parenthetical note without rewriting code or nesting spoilers. */
export function renderSourceMarkers(answer: string, prefix: 'L' | 'S', sources: CitationSources, enabled = true, concealSources = false): string {
  const marker = `\\[${prefix}\\d+\\](?:\\([^\\r\\n)]*\\))?`;
  const group = `(?:${marker}(?:[ \\t]*[,;·]?[ \\t]*(?=\\[${prefix}\\d+\\]))?)+`;
  const pattern = new RegExp(`\\((?:sources?:[ \\t]*)?(${group})\\)|(?:sources?:[ \\t]*)?(${group})`, 'gi');
  const spans = concealSources ? spoilerSpans(answer) : [];
  return mapProse(answer, (prose, offset) => {
    const rendered = prose.replace(pattern, (_original, wrapped: string | undefined, bare: string | undefined, position: number) => {
      const references = [...(wrapped ?? bare ?? '').matchAll(new RegExp(`\\[(${prefix}\\d+)\\]`, 'gi'))]
        .flatMap(match => sources.get(match[1]!.toUpperCase())?.slice(0, 1) ?? []);
      const note = enabled ? sourceNote(references) : '';
      if (!note) return '';
      const hidden = concealSources && !spans.some(span => offset + position >= span.start && offset + position < span.end);
      const previous = prose[position - 1];
      const next = prose[position + _original.length];
      return (previous && !/\s|\|/.test(previous) ? ' ' : '') + (hidden ? '||' + note + '||' : note) +
        (next && /[\p{L}\p{N}]/u.test(next) ? ' ' : '');
    });
    return rendered.replace(/[ \t]+([.,;!?])/g, '$1').replace(/\([ \t]*\)/g, '')
      .replace(/[ \t]+(?=\|\|(?:\s|[.,;!?]|$))/g, '');
  }).trim();
}
