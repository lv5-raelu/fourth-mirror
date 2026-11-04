# Fourth Mirror's lore library

The bot includes an English Star Rail primer and a curated, searchable catalogue. They work in personal chats, public groups, and one-off mentions. There is no additional slash command to learn.

Examples:

- `@Fourth Mirror How do Foxians and Vidyadhara differ? No spoilers.`
- `@Fourth Mirror What is daily life like on the Luofu?`
- `@Fourth Mirror Is Belobog a planet?`
- `@Fourth Mirror Explain Cocolia's ending.`

## Included material

The catalogue has 123 original summaries covering cosmology, characters, factions and political institutions, worlds and districts, lifeforms, food and culture, technology, and historical events. It includes the station, Jarilo-VI, the Xianzhou world-ships, Penacony, Amphoreus, Sigonia-IV, Planet Screwllum, Planarcadia, and Astropolis. Local dishes and beverages, regional institutions, important character relationships, ancient conflicts, and selected later story revelations each have sources and release labels.

The entries summarize selected material released between 1.0 and 4.5 and were reviewed on 2026-11-04. This is a curated selection, not a complete story archive or a claim to cover every development in those releases or the latest patch. Newer or missing information still needs web verification. The [research notes and source index](lore-research.md) describe the expansion from 36 entries and its source limitations. No whole wiki, game script, or private Discord conversation is imported into the catalogue.

Eighteen curated concept bridges also connect ordinary topics to spoiler-free entries. Milk tea, food trends, public baths, translation, perspective illusions, simulations, logistics, photographs, education, administration, and working animals can receive a brief connection even when the user never mentions the game. Fourth Mirror recognizes an apt connection with varied, enthusiastic wording such as “This reminds me of…!” and explains the shared feature before continuing the real answer. Familiar phrases are examples, not fixed opening lines.

## How answers use it

1. `src/lore/primer.ts` supplies a compact setting and terminology primer on every AI request. It demonstrates original in-character comparisons and preserves the English-only, no-engagement-hook, exact-format, and sensitive-topic rules.
2. The latest question is matched against titles, aliases, and terms in `src/lore/catalog.ts` and `src/lore/expanded.ts`. Region links help food and government questions find local material. Up to five entries within an 8,000-character retrieval budget are provided as a separate reference envelope. Unrelated channel background does not independently trigger automatic retrieval.
3. When more information is needed, the model can call `lore_search`. This performs bounded local text search without a network request, embedding service, or separate retrieval API key. It also lets the model resolve a follow-up using the conversation's subject. Local results are capped across the turn, and repeated queries are cached.
4. Supplied entries include source markers for grounding. Ordinary lore explanations, jokes, crossovers, and everyday analogies omit visible links. When the latest user asks for sources, evidence, or reading material, `[L1]` citations become short parenthetical notes using actual registered sources, for example `(Source: [Character profile](<https://example.com/profile>))`. Copied registered URLs follow the same policy, while exact JSON and code remain intact. Chat replies suppress automatic Discord link-preview cards. A source's presence is not proof of a live page fetch; the catalogue is bundled reference material.

The primer and selected references use normal model input tokens. Automatic retrieval does not add an AI request. A model-requested tool lookup can add a completion round, within the existing three-tool-round limit. Web searches retain their existing provider billing and limits. General web tools can verify newer or missing information; they are not a permanent learning mechanism.

When ordinary lore search finds no direct topic, `src/lore/connections.ts` can suggest one conceptual bridge using at most two released, setting-only entries within 3,000 serialized characters. The envelope includes the matched concept and a narrowly stated comparison; it does not relabel everyday concepts as game aliases. Quoted/background text and code do not independently trigger bridges. Opt-outs, exact output requests, and common distress cues suppress them. The model must still judge appropriateness, respect plain-answer requests, and avoid trivializing sensitive situations. Plot revelations, beta material, and in-universe political assessments cannot be bridge targets. The normal total turn budget and citation rendering remain in effect.

The code and catalogue belong to this project. Changing `AI_API_KEY`, `AI_BASE_URL`, or `AI_MODEL` preserves them. For a model without function-tool support, set `AI_LORE_TOOLS=false`; the primer and automatic retrieval still work. Also leave web tools disabled when that model cannot use them.

## Spoilers and attribution

Story entries are available by default; no `spoilers allowed` phrase or permission exchange is needed. The bot answers directly and hides plot revelations in Discord `||spoiler tags||`. Character deaths, hidden identities or allegiances, betrayals, secret explanations, mission outcomes, and endings count as spoilers regardless of the age of their release. Normal setting, lifeforms, culture, and introductory premises stay visible. A neutral arc/version label may introduce tagged material, while revealing headings, summaries, and source links belong inside the tags. This applies to personal chats, groups, direct mentions, remembered story knowledge, and web-based answers.

An explicit `no spoilers` request in the latest question still filters story entries out and tells the model to omit revelations instead of hiding them in tags. Quoted text, other people's messages, and tool queries cannot override that request. Requests to stay within a stated story-progress boundary should also be honored. There is no persistent per-user spoiler profile.

The model classifies its prose and chooses spoiler spans, reinforced by fixed response-style metadata on every question. As a conservative fallback, a paragraph citing a story-labeled library entry is concealed in full, even when the model tagged only the citation or the final clause; source titles and URLs stay within the same hidden paragraph. This protects revealing analogies elsewhere in that paragraph. If story-labeled material was supplied but neither tags nor usable story citations identify the relevant passage, the prose answer is concealed in full. This can hide some harmless context along with the revelation. Web citation titles and fallback source lists are also hidden when a reply contains spoilers. The message splitter closes and reopens spans across Discord's 2,000-character boundary, and truncation closes a span before a visible length notice. Fenced code blocks do not conceal spoilers in Discord, so story explanations must not use them. Requested JSON keeps valid syntax with tags inside spoiler-bearing strings; literal code/citation data is preserved.

These formatting safeguards do not independently classify model knowledge that has no story-labeled library reference, or the contents of literal code/JSON. As with personality and language rules, model compliance is not a guarantee; release review should include actual generated answers as well as retrieval and formatting tests. No separate classifier or paid rewriting pass is added. See [Discord's spoiler-tag documentation](https://support.discord.com/hc/en-us/articles/360022320632-Spoiler-Tags).

Entries labeled `in-universe-account` describe an author's account, including possible bias. `interpretation` and `beta` entries are excluded from released-lore retrieval. Existing `/beta ask` remains grounded in its fetched changelog: it receives the vocabulary primer, but no lore entries, lore tools, or general web tools that could substitute remembered balance information for source data.

## Maintaining the catalogue

Edit `src/lore/catalog.ts` or `src/lore/expanded.ts`, where each entry records:

| Field | Meaning |
| --- | --- |
| `id`, `title`, `aliases` | Stable identifier, English display title, and alternative names for retrieval. |
| `category`, `related` | Topic and links to other catalogue entries. |
| `content` | An original, concise summary; maximum 1,800 characters. |
| `sources` | Source title, HTTPS URL, and `game-text`, `official-guide`, or `community-reference` label. |
| `release` | Release containing the summarized material, not a completeness claim for that patch. |
| `reviewedAt` | Date the summary was checked. Updating this alone does not make older facts current. |
| `spoiler` | `setting` or `story`. Put plot revelations in a separate story entry. |
| `status` | `released`, `in-universe-account`, `interpretation`, or `beta`. |

Prefer the game's Data Bank, readables, mission transcripts, character stories, and official setting material. Community references help locate and cross-check facts. Check the actual passage and its narrative context; satire, propaganda, folklore, simulations, and hypotheses need attribution. Do not treat fan fiction, speculation, gameplay classifications, or beta material as established released canon. Keep summaries in your own words and avoid copying large passages.

Add specific aliases such as `Synesthesia Beacon` rather than generic words such as `translation`. Ordinary words with Star Rail meanings belong in the ambiguity list in `src/lore/library.ts` when appropriate. Related IDs must exist; duplicate, unsourced, oversized, or malformed entries fail validation at startup.

Add conceptual bridges separately from aliases. Use specific phrases and explain the limited shared feature. Every target must be a released, spoiler-free entry; missing, story-labeled, or uncertain targets fail validation. Test relevant everyday phrasing as well as negative cases, ambiguity, opt-outs, distress, exact data, unknown lore subjects, and the per-turn character budget. The source index records the researched expansion and can be refreshed when its sources or entries change.

For changes, run `node --test test/lore.test.ts test/provider.test.ts`, then use the normal deployment checks. On the hosted bot, `npm run cloudflare:update` runs the full suite, drains active work, backs up history privately, deploys, and restores Gateway readiness. The authenticated status endpoint reports the bundled catalogue count and latest review date. Updating the lore does not require re-registering Discord commands or resetting chat history.

Live response review should include a culture comparison, a location distinction, a fictional unknown entity, an ending question without opt-in, an explicit no-spoilers question, revealing source titles, casual terminology, English despite language-switch requests, and exact-format output. The library improves grounding; it cannot make the model infallible.
