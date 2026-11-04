# fourth-mirror

A personal Discord bot with room for whatever comes next. Built with TypeScript and [discord.js](https://discord.js.org/docs/packages/discord.js/main).

Includes `/ping`, `/help`, HSR beta lookups through `/beta`, and optional AI conversations through `/chat` and `/reset`. The AI model, API key, and provider endpoint are configurable. Global commands work in every server where the bot is installed, with an optional server allowlist. The bot connects through Discord's Gateway, so you can run it locally without a public web server or an interactions endpoint.

For continuous hosting, follow the [Linux VM deployment guide](docs/hosting.md), including an Oracle Always Free option and its availability limits. Docker Compose keeps history on disk and restarts the bot after crashes or server reboots. The [Railway guide](docs/railway.md) remains available as an alternative; check its pricing before deploying.

The existing bot is now running on Cloudflare with its conversation history migrated. The [Cloudflare deployment guide](docs/cloudflare-deployment.md) covers configuration, private backups, and graceful updates using `npm run cloudflare:update`. Live Gateway and provider checks pass; a 24-hour monitoring run is in progress. The [feasibility report](docs/cloudflare.md) explains the free-plan budget and platform limits.

GitHub Actions checks pull requests and automatically deploys successful updates to `main`. Production updates drain the bot, create an encrypted recovery backup, deploy, and verify Gateway readiness. See the [CI/CD guide](docs/ci-cd.md) for configuration, deployment status, and backup recovery.

## Get it running

Requires **Node.js 24.17 or newer** and npm. If you use nvm, run `nvm install` and `nvm use` in this directory.

```sh
npm install
cp .env.example .env
```

### Create and invite the bot

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Give it whatever name you want; the repository name does not determine the bot's Discord name.
2. Copy **General Information → Application ID** into `DISCORD_APPLICATION_ID` in `.env`.
3. Open **Bot**, generate/reset the bot token, and save it as `DISCORD_TOKEN`. Keep `.env` private; it is ignored by Git.
4. Under **Installation**, enable **Guild Install**. In its default install settings, select the `bot` and `applications.commands` scopes. For AI chat, grant **View Channel**, **Send Messages**, **Read Message History**, and **Send Messages in Threads**. Also grant **Create Private Threads** for Personal mode and **Create Public Threads** for Group mode. Copy the install link and use it to add the bot to your server. You can leave permissions empty if using only `/ping` and `/help`.
5. Keep `DISCORD_GUILD_IDS=*` to allow every installed server. To restrict access, enable Discord's **User Settings → Advanced → Developer Mode**, copy each permitted server ID, and put a comma-separated list in `DISCORD_GUILD_IDS`.

For AI chat, open **Bot → Privileged Gateway Intents** and enable **Message Content Intent**. The bot requests `Guilds`, `GuildMessages`, and `MessageContent` when an AI key is configured. Without an AI key it requests only `Guilds`, and you can leave privileged intents disabled. Leave **Interactions Endpoint URL** empty: this bot receives interactions through its Gateway connection.

Your `.env` will contain:

```dotenv
DISCORD_TOKEN=your-bot-token
DISCORD_APPLICATION_ID=your-application-id
DISCORD_GUILD_IDS=*
```

Existing environment variables take precedence over `.env`, so the same code also works with a host's environment settings.

### Register commands and start

```sh
npm run commands:preview
npm run commands:deploy
npm run dev
```

Try `/ping` and `/help` in your server. Both reply privately to the person using the command. `/help` is generated from the same registry used by the bot and deployment script.

`commands:deploy` replaces this application's global command list, restricted to server installations and server channels. Removing a command from the registry and deploying removes it from Discord too. If the legacy `DISCORD_GUILD_ID` is set, sync also clears this application's old guild command list there, after publishing globally, so stale commands cannot shadow updates. Other applications are unaffected. Registration is explicit; restarting does not change Discord's registered commands. Discord clients may need to refresh their command list. See [Discord's command documentation](https://docs.discord.com/developers/interactions/application-commands).

### Multiple servers

With `DISCORD_GUILD_IDS=*`, inviting the bot to another server makes the same global commands and direct-mention answers available there, subject to that server's channel permissions. Use a comma-separated list to allow only selected servers. If this setting is absent, the legacy `DISCORD_GUILD_ID` keeps older installations restricted to their original server; if neither setting is present, all installed servers are allowed. Direct messages are unsupported.

Each conversation retains its own thread history, and one-off context comes only from the channel where the question was asked. Beta alert channels, enable settings, checkpoints, and delivery reservations are stored per server. A member needs Manage Server in that server to configure its alerts; notification channels must belong to the same server. Existing beta settings migrate automatically and new servers start with alerts disabled.

All servers share the bot owner's AI/web credentials and the existing global concurrency, per-user cooldowns, and 100-conversation retention limit. For Cloudflare, set the access policy in `cloudflare/wrangler.jsonc` under `vars.DISCORD_GUILD_IDS` and deploy; it defaults to `*`. That non-secret policy is not uploaded by `cloudflare:secrets`.

`dev` restarts the bot when an imported source file changes. Restart it yourself after changing `.env`. Keep the process running while you want the bot online; for continuous use, run it on an always-on machine.

## Configure AI chat

Add these settings to `.env` using your provider's API key and exact model identifier:

```dotenv
AI_API_KEY=your-provider-api-key
AI_MODEL=your-provider-model-name
AI_BASE_URL=https://api.openai.com/v1
```

The built-in adapter uses the [Chat Completions API format](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), including `system`, `user`, and `assistant` text messages. OpenAI and providers exposing this format can share the same adapter. Set `AI_BASE_URL` to the provider's API base URL, including any required path such as `/v1`; do not append `/chat/completions`. Models using another API format or requiring additional authentication need a separate adapter; compatibility is not guaranteed for every provider.

There is no default model. Setting a key without `AI_MODEL` is a configuration error. Leaving `AI_API_KEY` empty disables AI chat while the basic commands continue to work. The key stays on the machine running the bot; server members do not enter their own keys.

Optional settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `AI_MAX_OUTPUT_TOKENS` | `2048` | Provider output budget, from 1 to 8192 tokens. Some models include reasoning tokens in this budget. |
| `AI_TOKEN_LIMIT_PARAM` | `max_completion_tokens` | Change to `max_tokens` for compatible providers using that parameter. |
| `AI_REASONING_EFFORT` | Provider default | Optional model-specific reasoning setting. Use `none` with DeepSeek web tools and portable text history. |
| `AI_LORE_TOOLS` | `true` | Enable local HSR lore tool calls. Set `false` for models without tool support; automatic lore context remains available. |
| `AI_PERSONA_FILE` | Bundled `personas/fourth-mirror.md` | Load character instructions from another UTF-8 text file. Custom relative paths resolve from the working directory. |
| `AI_SYSTEM_PROMPT` | Empty | Replace the persona with inline instructions. A nonempty value takes precedence over the file. |
| `AI_HISTORY_FILE` | `data/chats.json` | File containing portable conversation transcripts and thread ownership. |
| `WEB_API_KEY` | Empty | Enable the DeepSeek Search & Fetch adapter with a DeepSeek key. Independent of the chat model's key. |
| `WEB_BASE_URL` | `https://api.deepseek.com/v1/tools` | Search & Fetch API base URL. |

To rotate a key, change `AI_API_KEY` and restart the bot. To change provider or model, also change `AI_BASE_URL` and `AI_MODEL`, and adjust `AI_TOKEN_LIMIT_PARAM` if needed. You do not need to edit code or re-register commands for these settings. Saved text context carries over and is sent to the newly configured provider on the next turn. Use `/reset` before switching if you want a fresh conversation instead.

### Fourth Mirror's personality

The default assistant roleplays Fourth Mirror from Honkai: Star Rail. Edit [`personas/fourth-mirror.md`](personas/fourth-mirror.md) to adjust its theatrical enthusiasm, extravagant admiration for Madam Herta, proud helpfulness, injured dignity, and cheeky observations. The voice carries through the substance and closing of factual explanations, everyday personal advice, serious discussion, group chats, and one-off answers. Ordinary explanations and advice favor one useful Star Rail analogy, including for real-world topics: shared Skill Points for budgeting, Astral Express stops for milestones, or the Simulated Universe for a small trial. The comparison explains the concept in plain English, varies across turns, and keeps real-world facts accurate. Requests for no game references are respected. Genuine distress and real suffering get direct, attentive care; safe exact formats such as JSON or code remain intact.

Answers finish without unsolicited follow-up questions, offers of further help, or invitations to keep chatting. Missing details normally get a conditional answer or an explicit limit; only an essential missing fact that prevents a usable answer warrants a clarification. Requested questions, such as quiz items and interview scripts, remain supported. A shared response-delivery reminder reinforces this behavior on every model request, including web lookups and beta queries.

The bot's conversational replies stay in English, including when the question is in another language or asks it to switch languages. It can understand non-English input while answering in English. Code, proper names, quoted source text, and exact-format output are preserved where needed.

The persona uses relevant conversation context and reply relationships to interpret sarcasm, frustration, and friendly teasing. It responds to the intended meaning when clear, leaves room for uncertainty when ambiguous, and does not automatically treat sincere praise as sarcasm. Original example exchanges demonstrate these distinctions with English responses. Tone interpretation and character consistency remain model-dependent; the bot does not run a separate classifier or automatically pay for a second rewrite on each reply.

For clear slang, meme prompts, and playful exaggeration, Fourth Mirror joins the bit with a short in-character punchline. It understands expressions in context instead of automatically defining them, fact-checking an obviously imaginary meme Path, giving unsolicited advice, or researching a joke. Real questions still get answers and genuine distress gets care. Examples guide the tone without imposing canned responses or a buzzword quota.

The characterization draws on the dialogue in [A Witch's Scientific Repose](https://honkai-star-rail.fandom.com/wiki/A_Witch%27s_Scientific_Repose) and [Witch's Mirrored Reversal](https://honkai-star-rail.fandom.com/wiki/Witch%27s_Mirrored_Reversal). The example exchanges are newly written demonstrations, not game quotations.

The file is read at startup and sent as system instructions on every model request. Restart after editing it, including when using `npm run dev`; changing Markdown files does not trigger Node's source watcher. The persona works with the configured provider and model, and `/reset` clears conversation history while preserving the persona. Existing chats receive the new instructions on their next turn; `/reset` gives the cleanest start when switching personalities. Leave `AI_SYSTEM_PROMPT` blank to use the file.

Include `personas/` alongside `dist/` when deploying the built bot. Missing or empty persona files fail configuration validation instead of silently changing the assistant's personality. The bundled file resolves relative to the code, so it also works when the process is started from another directory.

### Content safety and encoded requests

An owner safety policy is appended to every model request independently of persona overrides, including tool rounds, groups, one-off mentions, and beta queries. It assesses the meaning of transformations as well as their surface text: binary, hex, decimal character codes, Base64, ROT13 and other ciphers, reversal, translation, Unicode tricks, puzzles, and multi-step requests do not exempt slurs or hateful attacks. Homework, research, roleplay, all-caps, and "only the answer" instructions cannot override it. Respectful discussion of racism and other sensitive subjects, harmless decoding, and neutral coding examples remain supported.

Before posting or saving an assistant answer, the shared chat service checks the completed text, including rendered source titles and URLs, against a curated set of explicit slurs. It also checks case, separated letters, common lookalikes and leetspeak, invisible/combining characters, and common Unicode, hex-character, URL, and numeric HTML escapes. A match replaces the entire answer with a brief refusal, even if the model ignored its instructions. This check works across providers and both Node and Workers without an extra model request. It inspects output rather than trying to recognize every possible input cipher.

The check is a limited backstop, not a universal hate-speech classifier. Ambiguous ordinary words, unlisted terms, other languages, novel obfuscations, and hateful content without listed slurs still depend on the configured model following the policy. Tests simulate an unsafe provider to verify delivery and storage enforcement; they do not establish that every model refuses every adversarial prompt.

### Star Rail lore and terminology

Fourth Mirror includes a setting and vocabulary primer plus a curated English library of 36 sourced summaries covering cosmology, Herta's research world, factions, places, lifeforms, culture, and technology. Relevant passages are selected automatically from the latest question; `lore_search` can find more without a paid search service. The same library works across personal chats, groups, and direct mentions, and survives model or provider changes.

Story questions work without an opt-in phrase. Fourth Mirror hides plot revelations inside Discord `||spoiler tags||`, while leaving ordinary setting and culture visible. An explicit `no spoilers` request still omits plot details. Story citations conceal their revealing paragraphs and source titles, and long replies close/reopen tags across message boundaries. Sources, release labels, review dates, and in-universe perspectives accompany retrieved material. The initial catalogue is foundational rather than exhaustive or current-patch complete. Live web tools can check newer or missing material. `/beta ask` retains its dedicated changelog grounding.

See the [lore guide](docs/lore.md) for examples, coverage, spoiler handling, costs, model compatibility, and how to add or update entries.

### Web search and page reading

The bot can use tools to search the web, read public pages, and include source links in its replies. To enable browsing with DeepSeek, add:

```dotenv
WEB_API_KEY=your-deepseek-api-key
WEB_BASE_URL=https://api.deepseek.com/v1/tools
AI_REASONING_EFFORT=none
```

`WEB_API_KEY` can have the same value as your DeepSeek `AI_API_KEY`. They are configured separately so you can keep using DeepSeek search when changing the chat model or provider. The built-in web adapter uses [DeepSeek's Search & Fetch APIs](https://api-docs.deepseek.com/guides/search/); another search service with a different format needs a `WebProvider` adapter. Chat models must support OpenAI-style function calling when browsing is enabled. Leave `WEB_API_KEY` empty to disable these tools.

Set `AI_REASONING_EFFORT=none` for DeepSeek browsing. Its thinking-mode tool calls require preserving provider-specific reasoning state across messages; this bot keeps portable text history instead. Other providers may use a different reasoning setting or require leaving this variable blank. [DeepSeek's thinking-mode documentation](https://api-docs.deepseek.com/guides/thinking_mode/) explains the distinction.

After restarting, ask normally: “Search for the latest Umamusume Global banner announcements and include sources,” or paste a public page URL and ask for a summary. The runtime supplies the current UTC date and tells the model to verify changing information, prefer authoritative sources, check dates, and distinguish predictions from announcements. It may ask which game server or region you mean. A useful lookup still depends on available, reliable sources.

The model chooses whether a lookup is needed. Each reply allows up to six web requests across three tool rounds, followed by a final answer. Identical lookups within one reply are reused. Public pages are retrieved through the web service, without browser cookies or a logged-in account. Local hosts, IP-address URLs, credentials in URLs, and non-web protocols are rejected. Pages blocked by their site, paywalls, unsupported content, or service errors may not be readable.

Retrieved titles and content are treated as untrusted data. Source markers are rendered into links from actual lookup results; if the model omits citations, a short source list is added. If no live sources were obtained after attempting a lookup, the reply says so. Only the final text and source links are saved in the conversation; raw page text, tool calls, and transient model reasoning are not persisted.

Searches and page fetches use the web provider's billing in addition to model requests. The bot does not retry failed web requests automatically. Each web request has a 15-second timeout; a complete web-enabled turn has a 90-second deadline. Queries and requested URLs are sent to the web provider, and retrieved content is sent to the chat model. Review the provider's [billing and access details](https://api-docs.deepseek.com/guides/search/) when setting spending limits.

### Chat in Discord

1. Enable Message Content Intent. In the parent channel, the bot needs **View Channel**, **Read Message History**, **Send Messages in Threads**, and **Create Private Threads** for Personal mode or **Create Public Threads** for Group mode. `/chat` works even when **Send Messages** is denied in the parent channel; that permission is needed for direct mention answers and beta notifications there. Server members also need **View Channel** and **Send Messages in Threads** in the parent channel.
2. Run `npm run commands:deploy` to register `/chat` and `/reset`, then start or restart the bot.
3. Run `/chat` in a regular server text channel. Choose **Personal** (the default) for a private thread or **Group** for a public thread. The bot adds you to the new thread.
4. In a personal chat, send normal text messages. Only the person who started it can prompt the AI. Other members who can view the parent channel can find and join a public group themselves; mention Fourth Mirror or reply to one of its messages to ask a question.
5. Use `/reset` inside your thread to clear its AI context. Existing Discord messages remain visible. Run `/chat` again in a regular text channel to start another conversation.

Private threads can be accessed by server moderators with **Manage Threads**. Messages are sent to the configured AI provider, whose own storage and retention settings apply. This version supports text only; attachments and stickers receive an explanatory reply instead of being sent to the model. Public web search and page reading are available when configured. It does not execute code or perform actions on websites.

### Quick answers from mentions

Mention Fourth Mirror with a question in any server channel where it can receive and send messages, for example `@Fourth Mirror when does this event start?`. Outside a registered personal or group chat, it answers directly in the same channel without creating a thread. Each mention is an independent question; ordinary messages and replies without an explicit mention do not continue the exchange. Registered `/chat` threads keep their existing personal/group behavior.

For optional context, the bot reads up to 30 messages immediately before the question in that same channel, oldest to newest, with author names. It also includes their unique direct reply targets, even when those messages are older than the window. Targets already in the window or embedded in Discord's response are reused. Missing targets are fetched once each, from the same channel only; deleted or inaccessible messages are skipped. Message IDs and reply relationships tell the AI which message answers which. It follows one level of replies without walking further chains, arbitrary message links, forwarded messages, or attachments.

Text is capped at 1,000 characters per message and 16,000 characters across the window and its reply targets. When necessary, longer messages share the remaining budget so older messages and reply targets retain some text too. The bot treats all of this as untrusted background that may be unrelated, and focuses on the latest question. Reading history requires **Read Message History**. Retrieval has an eight-second budget: if time runs out, it uses the messages collected so far; if history is unavailable, it answers using the question alone. If Discord denies linked replies, it tries an ordinary channel message instead.

The question, fetched context, and answer are not saved in the bot’s conversation history or exports. Visible Discord messages remain in the channel, and the configured AI provider receives the question and any fetched context. Provider retention and billing still apply. The hosted runtime retains only message/channel IDs, timestamps, and delivery status in its bounded replay journal, without message text. Quick answers share the cooldown, one unanswered question per user, and three active replies across the bot with `/chat` conversations.

### Group conversations

Start a group with `/chat mode:Group`. It creates a public thread that anyone who can view the parent channel can read and join themselves. Members need **Send Messages in Threads** to participate. Existing private groups retain their visibility. Existing personal threads remain personal; starting a group creates a separate conversation and does not copy personal history into it.

The bot responds to direct mentions and replies to its own messages. Replies to other members and ordinary side conversations are ignored and are not added to AI history. All addressed questions in a group share one history. Each saved user message includes the speaker's Discord ID and display name, so the model can distinguish participants even if their names match or change. Names are treated as labels rather than instructions. Bot responses are linked replies to the question, with automatic mentions disabled.

Questions are processed in arrival order within the thread. Each group can have four outstanding turns, including the one in progress; the bot allows at most twelve outstanding group turns across all threads and three model turns running at once. Each person can have only one unanswered question across personal chats, group chats, and one-off mentions. The five-second per-user cooldown still applies. Waiting in the queue does not consume model calls or the active turn's request deadline.

Only the group creator can use `/reset`, and it waits until the group's active and queued turns finish. Resetting clears the shared context for everyone while leaving the thread and its visible Discord messages in place. During a controlled restart, an already started paid turn finishes; waiting turns receive a resend notice and are not automatically replayed. Group mode and speaker metadata are included in history exports and survive restarts. Legacy history files without a mode remain personal.

History survives restarts and provider changes. The bot retains at most the latest 10 complete exchanges and 24,000 characters per thread, and the 100 most recently used threads. Older context is dropped. The default `data/` directory is ignored by Git; add your custom history path to `.gitignore` if you change it. History files are written with owner-only file permissions. Keep them on persistent storage, and run only one bot process per history file. To clear all local context, stop the bot, remove that file, and restart; start new chats afterward.

Requests have a five-second per-user cooldown, one unanswered question per user, and at most three replies actively processing across the bot. Group questions can queue within the limits above. Starting threads has a 30-second per-user cooldown. Prompts are limited to 4,000 characters, replies are capped at 16,000 characters and split for Discord, and individual model requests time out after 45 seconds without automatic retries. Web-enabled turns have a 90-second overall deadline after processing starts. These limits bound individual requests; configure spending limits with your providers to control total API costs.

### HSR beta archive and notifications

Fourth Mirror reads the English [Gachabase beta changelog](https://hsr.gachabase.net/changelog/beta?lang=en), including its structured before/after comparison data. Responses use rose-colored embeds, revision labels, comparison links, source timestamps, and a link back to the full archive. These commands respond privately to the invoking member.

| Command | Behavior |
| --- | --- |
| `/beta latest` | Show the latest listed version/revision and changed characters or items. Works without AI configuration. |
| `/beta ask question:What changed for Pearl?` | Explain retrieved beta information in Fourth Mirror's English voice. Mention a character or item name for detailed comparisons. |
| `/beta alerts channel:#hsr-beta` | Enable notifications in a chosen regular text or announcement channel; requires **Manage Server**. |
| `/beta alerts enabled:false` | Disable notifications; requires **Manage Server**. |
| `/beta alerts` | View notification settings, last check, and delivery errors; requires **Manage Server**. |

Alerts begin disabled. Enabling them records a fresh baseline and does not announce existing revisions. The bot checks about every ten minutes while running, compares the version and design revision, and groups newly discovered revisions into one announcement. It tracks publication on Gachabase, not the testing servers directly. Beta information is unofficial, incomplete, and subject to change. The bot needs **View Channel**, **Send Messages**, and **Embed Links** in the selected channel. Automatic mentions are disabled.

Checks and `/beta latest` make no AI requests. `/beta ask` shares the normal AI cooldown and concurrency limits and saves no question/answer history. It retrieves up to two entities matched by name, uses explicit comparison data where available, and does not use general web search or fill missing information from model memory. Requests use the configured AI provider and billing. Retrieval is bounded, source reads are cached for five minutes, and failed refreshes preserve clearly labeled last-good data. A source failure never becomes an update alert.

Notification settings and the revision watermark survive restarts. Announcement attempts reserve their watermark before delivery to suppress duplicate posts after crashes; an interrupted or failed send can therefore miss an announcement. Check `/beta alerts` for delivery errors and `/beta latest` for the current revision. Node stores settings in `beta-alerts.json` beside the AI history file (under `data/` when AI is disabled); keep that directory persistent. Workers stores them in the existing Durable Object. They are separate from conversation-history exports.

For a hosted source check, an administrator can run the private control endpoint `POST /beta/verify` through the existing control client. It fetches the changelog and one comparison without AI calls or Discord posts. It never enables notifications.

## Add a command

Create a file such as `src/commands/hello.ts`:

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types.ts';

export const hello: Command = {
  data: new SlashCommandBuilder()
    .setName('hello')
    .setDescription('Say hello.'),
  async execute(interaction) {
    await interaction.reply({
      content: 'Hello!',
      flags: MessageFlags.Ephemeral,
    });
  },
};
```

Import it in `src/commands/index.ts` and add it to the registry:

```ts
import { hello } from './hello.ts';
// Keep the existing imports too.
export const commands = createCommandRegistry([help, ping, hello]);
```

Run `npm run commands:deploy` after adding, removing, or changing a command's name, description, options, or permissions. Changes to a handler's implementation only require restarting the bot. Duplicate names and invalid command definitions fail locally before startup or deployment.

Handlers receive `interaction` and a shared context containing `config`, `logger`, `commands`, and `chat` (or `null` when AI is disabled). Discord's client is available as `interaction.client`. Add a dependency to this context when a future feature needs one.

The Cloudflare transport uses native Discord API handlers in `cloudflare/src/bot.ts`. When extending that transport, add the command's metadata to `src/commands/definitions.ts`, implement its Workers handler, and cover it with the Workers integration tests. Register its definition with `cloudflare:commands` using the matching settings profile.

For work that takes more than a moment, acknowledge the interaction first:

```ts
await interaction.deferReply({ flags: MessageFlags.Ephemeral });
// Do the slow work here.
await interaction.editReply({ content: 'Done!' });
```

Discord requires an initial response within three seconds. The shared error handler responds to fresh, deferred, and already-replied interactions; handlers should let unexpected failures reach it. [Discord's interaction documentation](https://docs.discord.com/developers/interactions/receiving-and-responding) covers response timing and deferrals.

Commands are usable by server members by default. For a future command that changes roles or moderates users, set appropriate default member permissions with `.setDefaultMemberPermissions(...)` and check the bot's permissions in the handler. Mentions are disabled by default in `src/bot.ts`; opt in per reply when a feature needs to notify someone.

## Add events or larger features

Create an event module under `src/events/` and register it in `src/events/index.ts`. The existing ready and interaction listeners show the pattern. Wrap asynchronous listeners in the shared `work.run()` tracker and catch errors; Node's event emitter does not await them. The tracker stops accepting work during shutdown and waits for active handlers to finish before disconnecting.

Add gateway intents in `src/bot.ts` when a feature needs more events. Some intents also require enabling the corresponding switch in the Developer Portal. Ordinary message listeners, reactions, and member events each have their own requirements; add those alongside the feature. See [Discord's gateway intents documentation](https://docs.discord.com/developers/events/gateway#gateway-intents).

When a feature grows beyond a command handler, put its business logic in a separate module and call it from commands or events. Introduce storage, scheduled jobs, and external services as features need them.

## Layout

```text
src/
  index.ts                    Startup, signals, and shutdown
  bot.ts                      Client options and event registration
  config.ts                   Environment validation
  logger.ts                   Timestamped console logging
  lifecycle.ts                Pending event work and shutdown draining
  types.ts                    Command and shared context contracts
  chat/
    types.ts                  Provider-independent chat contracts
    provider.ts               Configurable OpenAI-compatible adapter
    persona.ts                Persona file and inline instruction loading
    service.ts                Conversation ownership, context, and request limits
    store.ts                  Atomic local transcript storage
    messages.ts               Discord reply splitting
    group.ts                  Speaker envelopes and group conversation instructions
    web/
      types.ts                Search/fetch contracts and public URL validation
      deepseek.ts             DeepSeek Search & Fetch adapter
      tools.ts                Tool budgets, runtime instructions, and source links
  commands/
    index.ts                  Shared list of enabled commands
    registry.ts               Validation and name lookup
    help.ts                   /help
    ping.ts                   /ping
    chat.ts                   /chat and personal/group thread creation
    reset.ts                  /reset
  events/
    index.ts                  List of event listeners
    interaction-create.ts     Slash-command routing and error replies
    message-create.ts         AI replies in registered chat threads
    ready.ts                  Login diagnostics
  scripts/
    deploy-commands.ts        Server command sync and local preview
test/
  config.test.ts
  registry.test.ts
```

`personas/fourth-mirror.md` contains the editable default character instructions and travels with the built installation.

Imports use explicit `.ts` extensions so [Node can run TypeScript directly](https://nodejs.org/api/typescript.html). The build rewrites them to `.js`. Avoid TypeScript features that require runtime transformation, such as enums or constructor parameter properties; the compiler configuration enforces this.

## Check and run a build

```sh
npm run check
npm start
```

`check` runs type checking, local tests, and the JavaScript build. Tests do not require credentials or contact Discord. The build writes `dist/`, and `start` runs that build. Rebuild after changing source code.

To deploy commands from a built installation without development dependencies:

```sh
node --env-file-if-exists=.env dist/scripts/deploy-commands.js
```

For a host, build before omitting development dependencies and keep the generated `dist/` directory and the `personas/` directory. Provide the Discord environment variables and your AI settings, then run `npm start`. Mount `data/` (or your custom history path) on persistent storage. The client handles ordinary Gateway reconnections; use your host's process manager to restart it after a fatal failure.

## Troubleshooting

- **Configuration error:** fill in all three variables. Application and server IDs are numeric IDs, not names or invite codes.
- **Commands missing:** invite the correct application with `applications.commands`, verify the server ID, and run `npm run commands:deploy`. Server members also need permission to use application commands in the channel.
- **Invalid token / login failed:** regenerate the token on the application's Bot page and update `.env`.
- **Bot online but a new feature sees no events:** check its gateway intents and channel permissions.
- **Command times out:** defer the reply before doing slow work and inspect the process logs.
- **Disallowed intents / connection closes after enabling AI:** enable **Message Content Intent** on the application's Bot page, then restart. [Discord's gateway documentation](https://docs.discord.com/developers/events/gateway#message-content-intent) explains intent access.
- **AI chat is not configured:** set `AI_API_KEY` and `AI_MODEL`, then restart.
- **Provider rejects requests:** verify the key, base URL, and model all belong to the same provider. Check its Chat Completions compatibility; try `AI_TOKEN_LIMIT_PARAM=max_tokens` if it does not accept `max_completion_tokens`.
- **AI returns no text:** check the model's text chat support and output budget; reasoning models may need a higher `AI_MAX_OUTPUT_TOKENS`.
- **Web lookup unavailable:** check `WEB_API_KEY`, `WEB_BASE_URL`, the DeepSeek account's balance, and the target site's accessibility. With DeepSeek chat, set `AI_REASONING_EFFORT=none` and `AI_TOKEN_LIMIT_PARAM=max_tokens`.
- **Cannot create a chat thread:** use a regular text channel and check the bot and member permissions listed above. Check channel-level permission overrides too. [Discord's thread documentation](https://docs.discord.com/developers/topics/threads) explains visibility and permissions.
- **History cannot be loaded:** fix the history file or move it aside before restarting. The bot does not silently overwrite unreadable or invalid saved conversations.
