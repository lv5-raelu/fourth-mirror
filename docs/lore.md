# Fourth Mirror's lore library

The bot includes an English Star Rail primer and a curated, searchable catalogue. They work in personal chats, public groups, and one-off mentions. There is no additional slash command to learn.

Examples:

- `@Fourth Mirror How do Foxians and Vidyadhara differ? No spoilers.`
- `@Fourth Mirror What is daily life like on the Luofu?`
- `@Fourth Mirror Is Belobog a planet?`
- `@Fourth Mirror Explain Cocolia's ending. Spoilers allowed.`

## Included material

The initial catalogue has 36 original summaries covering cosmology, Herta and Fourth Mirror, the station and its research, factions, locations, lifeforms, technology, culture, and selected history. Examples include Aeons, Pathstriders, Emanators, the Genius Society, the IPC, Jarilo-VI, the Xianzhou, Foxians, Vidyadhara, inorganic life, Penacony, Pepeshi, Halovians, currencies, and translation technology. Amphoreus has an introduction-era setting entry.

This is a foundational selection, not a complete story archive or a claim to cover the latest patch. The entries summarize material released between 1.0 and 3.0 and were reviewed on 2026-11-04. Later developments need additional entries or verification through the existing web tools. No whole wiki, game script, or private Discord conversation is imported into the catalogue.

## How answers use it

1. `src/lore/primer.ts` supplies a compact setting and terminology primer on every AI request. It demonstrates original in-character comparisons and preserves the English-only, no-engagement-hook, exact-format, and sensitive-topic rules.
2. The latest question is matched against titles, aliases, and terms in `src/lore/catalog.ts`. Up to five entries within an 8,000-character retrieval budget are provided as a separate reference envelope. Unrelated channel background does not independently trigger automatic retrieval.
3. When more information is needed, the model can call `lore_search`. This performs bounded local text search without a network request, embedding service, or separate retrieval API key. It also lets the model resolve a follow-up using the conversation's subject. Local results are capped across the turn, and repeated queries are cached.
4. Supplied entries include source markers. `[L1]` citations in the answer become links to the actual registered sources. Casual terminology does not need a citation. A source's presence is not proof of a live page fetch; the catalogue is bundled reference material.

The primer and selected references use normal model input tokens. Automatic retrieval does not add an AI request. A model-requested tool lookup can add a completion round, within the existing three-tool-round limit. Web searches retain their existing provider billing and limits. General web tools can verify newer or missing information; they are not a permanent learning mechanism.

The code and catalogue belong to this project. Changing `AI_API_KEY`, `AI_BASE_URL`, or `AI_MODEL` preserves them. For a model without function-tool support, set `AI_LORE_TOOLS=false`; the primer and automatic retrieval still work. Also leave web tools disabled when that model cannot use them.

## Spoilers and attribution

The default is setting and culture only. Plot entries require an explicit allowance in the latest question, such as `spoilers allowed`, `include plot spoilers`, or `spoil the ending`. A request for no spoilers takes precedence. Permission in earlier turns, other people's channel messages, quoted text, or a tool-generated query does not enable plot entries. Permission applies to that question only; there is no persistent opt-in or per-user spoiler profile.

The retrieval filter enforces what the library supplies. Prompt instructions also tell the model not to bypass the policy using remembered knowledge or web results. As with personality and language rules, model compliance is not a guarantee; setting-only entries and explicit model-response checks should remain part of release review.

Entries labeled `in-universe-account` describe an author's account, including possible bias. `interpretation` and `beta` entries are excluded from released-lore retrieval. Existing `/beta ask` remains grounded in its fetched changelog: it receives the vocabulary primer, but no lore entries, lore tools, or general web tools that could substitute remembered balance information for source data.

## Maintaining the catalogue

Edit `src/lore/catalog.ts`, where each entry records:

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

For changes, run `node --test test/lore.test.ts test/provider.test.ts`, then use the normal deployment checks. On the hosted bot, `npm run cloudflare:update` runs the full suite, drains active work, backs up history privately, deploys, and restores Gateway readiness. The authenticated status endpoint reports the bundled catalogue count and latest review date. Updating the lore does not require re-registering Discord commands or resetting chat history.

Live response review should include a culture comparison, a location distinction, a fictional unknown entity, default spoiler protection, explicitly allowed spoilers, casual terminology, English despite language-switch requests, and exact-format output. The library improves grounding; it cannot make the model infallible.
