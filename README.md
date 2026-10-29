# fourth-mirror

A personal Discord bot with room for whatever comes next. Built with TypeScript and [discord.js](https://discord.js.org/docs/packages/discord.js/main).

Includes `/ping`, `/help`, and optional AI conversations through `/chat` and `/reset`. The AI model, API key, and provider endpoint are configurable. Commands are scoped to one server. The bot connects through Discord's Gateway, so you can run it locally without a public web server or an interactions endpoint.

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
4. Under **Installation**, enable **Guild Install**. In its default install settings, select the `bot` and `applications.commands` scopes. For AI chat, grant **View Channel**, **Send Messages**, **Read Message History**, **Create Private Threads**, and **Send Messages in Threads**. Copy the install link and use it to add the bot to your server. You can leave permissions empty if using only `/ping` and `/help`.
5. In Discord, enable **User Settings → Advanced → Developer Mode**. Right-click your server, choose **Copy Server ID**, and save it as `DISCORD_GUILD_ID`.

For AI chat, open **Bot → Privileged Gateway Intents** and enable **Message Content Intent**. The bot requests `Guilds`, `GuildMessages`, and `MessageContent` when an AI key is configured. Without an AI key it requests only `Guilds`, and you can leave privileged intents disabled. Leave **Interactions Endpoint URL** empty: this bot receives interactions through its Gateway connection.

Your `.env` will contain:

```dotenv
DISCORD_TOKEN=your-bot-token
DISCORD_APPLICATION_ID=your-application-id
DISCORD_GUILD_ID=your-server-id
```

Existing environment variables take precedence over `.env`, so the same code also works with a host's environment settings.

### Register commands and start

```sh
npm run commands:preview
npm run commands:deploy
npm run dev
```

Try `/ping` and `/help` in your server. Both reply privately to the person using the command. `/help` is generated from the same registry used by the bot and deployment script.

`commands:deploy` replaces this application's entire command list **in the configured server**. Removing a command from the registry and deploying removes it from Discord too. Other applications and global commands are unaffected. Registration is an explicit step; restarting the bot does not change Discord's registered commands. [Discord's command documentation](https://docs.discord.com/developers/interactions/application-commands) explains guild command registration.

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
| `AI_SYSTEM_PROMPT` | A helpful, concise fourth-mirror assistant | Customize the assistant's instructions and personality. |
| `AI_HISTORY_FILE` | `data/chats.json` | File containing portable conversation transcripts and thread ownership. |

To rotate a key, change `AI_API_KEY` and restart the bot. To change provider or model, also change `AI_BASE_URL` and `AI_MODEL`, and adjust `AI_TOKEN_LIMIT_PARAM` if needed. You do not need to edit code or re-register commands for these settings. Saved text context carries over and is sent to the newly configured provider on the next turn. Use `/reset` before switching if you want a fresh conversation instead.

### Chat in Discord

1. Enable Message Content Intent and grant the bot the permissions listed above. Server members also need **View Channel** and **Send Messages in Threads** in the parent channel.
2. Run `npm run commands:deploy` to register `/chat` and `/reset`, then start or restart the bot.
3. Run `/chat` in a regular server text channel. The bot opens a private thread and adds you.
4. Send normal text messages in that thread. Only the person who started it can prompt the AI; other channels, bots, webhooks, and other members' messages are ignored.
5. Use `/reset` inside your thread to clear its AI context. Existing Discord messages remain visible. Run `/chat` again in a regular text channel to start another conversation.

Private threads can be accessed by server moderators with **Manage Threads**. Messages are sent to the configured AI provider, whose own storage and retention settings apply. This version supports text only; attachments and stickers receive an explanatory reply instead of being sent to the model. It does not browse, execute code, or use tools.

History survives restarts and provider changes. The bot retains at most the latest 10 complete exchanges and 24,000 characters per thread, and the 100 most recently used threads. Older context is dropped. The default `data/` directory is ignored by Git; add your custom history path to `.gitignore` if you change it. History files are written with owner-only file permissions. Keep them on persistent storage, and run only one bot process per history file. To clear all local context, stop the bot, remove that file, and restart; start new chats afterward.

Requests have a five-second per-user cooldown, one active reply per user, and at most three provider requests in progress across the bot. Starting threads has a 30-second per-user cooldown. Prompts are limited to 4,000 characters, replies are capped at 16,000 characters and split for Discord, and provider requests time out after 45 seconds without automatic retries. These limits bound individual requests; configure a spending limit with your provider to control total API costs.

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

For work that takes more than a moment, acknowledge the interaction first:

```ts
await interaction.deferReply({ flags: MessageFlags.Ephemeral });
// Do the slow work here.
await interaction.editReply({ content: 'Done!' });
```

Discord requires an initial response within three seconds. The shared error handler responds to fresh, deferred, and already-replied interactions; handlers should let unexpected failures reach it. [Discord's interaction documentation](https://docs.discord.com/developers/interactions/receiving-and-responding) covers response timing and deferrals.

Commands are usable by server members by default. For a future command that changes roles or moderates users, set appropriate default member permissions with `.setDefaultMemberPermissions(...)` and check the bot's permissions in the handler. Mentions are disabled by default in `src/bot.ts`; opt in per reply when a feature needs to notify someone.

## Add events or larger features

Create an event module under `src/events/` and register it in `src/events/index.ts`. The existing ready and interaction listeners show the pattern. Catch errors inside asynchronous event handlers; Node's event emitter does not await them.

Add gateway intents in `src/bot.ts` when a feature needs more events. Some intents also require enabling the corresponding switch in the Developer Portal. Ordinary message listeners, reactions, and member events each have their own requirements; add those alongside the feature. See [Discord's gateway intents documentation](https://docs.discord.com/developers/events/gateway#gateway-intents).

When a feature grows beyond a command handler, put its business logic in a separate module and call it from commands or events. Introduce storage, scheduled jobs, and external services as features need them.

## Layout

```text
src/
  index.ts                    Startup, signals, and shutdown
  bot.ts                      Client options and event registration
  config.ts                   Environment validation
  logger.ts                   Timestamped console logging
  types.ts                    Command and shared context contracts
  chat/
    types.ts                  Provider-independent chat contracts
    provider.ts               Configurable OpenAI-compatible adapter
    service.ts                Conversation ownership, context, and request limits
    store.ts                  Atomic local transcript storage
    messages.ts               Discord reply splitting
  commands/
    index.ts                  Shared list of enabled commands
    registry.ts               Validation and name lookup
    help.ts                   /help
    ping.ts                   /ping
    chat.ts                   /chat and private thread creation
    reset.ts                  /reset
  events/
    index.ts                  List of event listeners
    interaction-create.ts     Slash-command routing and error replies
    message-create.ts         AI replies in registered private threads
    ready.ts                  Login diagnostics
  scripts/
    deploy-commands.ts        Server command sync and local preview
test/
  config.test.ts
  registry.test.ts
```

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

For a host, build before omitting development dependencies and keep the generated `dist/` directory. Provide the Discord environment variables and your AI settings, then run `npm start`. Mount `data/` (or your custom history path) on persistent storage. The client handles ordinary Gateway reconnections; use your host's process manager to restart it after a fatal failure.

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
- **Cannot create a chat thread:** use a regular text channel and check the bot and member permissions listed above. Check channel-level permission overrides too. [Discord's thread documentation](https://docs.discord.com/developers/topics/threads) explains visibility and permissions.
- **History cannot be loaded:** fix the history file or move it aside before restarting. The bot does not silently overwrite unreadable or invalid saved conversations.
