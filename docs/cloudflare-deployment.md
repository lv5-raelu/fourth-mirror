# Run Fourth Mirror on Cloudflare

The Workers adapter supports `/ping`, `/help`, `/chat`, `/reset`, and `/beta`, with owner-only personal chats in private threads and shared group chats in public threads. Direct mentions outside registered chats get one-off answers in the same channel, with optional recent-channel context and no saved conversation content. `/beta` provides Gachabase beta queries and opt-in update notifications. It uses one SQLite Durable Object for the whole bot. The Node/Docker runtime remains available.

**Current setup:** the existing Discord application is running on the production Worker `fourth-mirror`. Its conversation was backed up and imported, and the import/export round trip matched. Live checks passed for Discord authentication, Gateway readiness/heartbeats, thread permissions, and AI/search access from Cloudflare. The 24-hour monitor is running; it has not yet completed. `fourth-mirror-staging` is stopped.

## Existing bot or separate test application

The workspace's private `.env.cloudflare` now contains the **production** Worker URL, a generated admin secret, and the existing bot/provider settings. `.env.cloudflare.staging` preserves the unused staging profile. Scripts load the selected file separately from `.env`; file values take precedence over shell settings. Never commit or share either file. Use `npm run cloudflare:update` for normal updates.

A separate test application is optional. Reusing the existing bot requires stopping its local process before starting Cloudflare and transferring a consistent history snapshot. That cutover has been completed here. Keep the local copy stopped while the hosted bot runs.

For optional testing alongside a live production bot:

1. Create a **separate application** in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Put its bot token and application ID in `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID` in `.env.cloudflare`. Keep the existing guild ID to test in your server, or use a separate test server.
3. Enable **Message Content Intent** under Bot. Leave **Interactions Endpoint URL empty**.
4. Install the test application into the configured server with `bot` and `applications.commands` scopes. Grant **View Channel**, **Send Messages**, **Read Message History**, and **Send Messages in Threads**, plus **Create Private Threads** for Personal mode and **Create Public Threads** for Group mode. The invoking member also needs View Channel and Send Messages in Threads in the parent channel.

Profiles whose Worker name ends in `-staging` reject credentials matching the existing `.env`. For an existing-bot cutover, use the production name `fourth-mirror`; the staging guard does not apply to that explicitly chosen production profile.

For a fresh checkout, use Node 24.17+ and run:

```sh
npm ci
npm run cloudflare:setup -- --copy-providers
npx wrangler login
```

Setup creates `.env.cloudflare` with mode `600` and refuses to overwrite an existing file. `--copy-providers` copies AI/web settings and the guild ID, not the existing Discord token. It does not upload them. Keep the account on **Workers Free**; no paid-plan activation is needed for SQLite Durable Objects. Review the [free-tier budget](cloudflare.md) before adding other workloads.

## Configure and start a deployment

The current production deployment is already configured and running. For a new profile, after filling its credentials and installing the bot:

```sh
npm run cloudflare:secrets -- --dry-run
npm run cloudflare:secrets
npm run cloudflare:commands -- --dry-run
npm run cloudflare:commands
npm run cloudflare:control -- start
npm run cloudflare:control -- status
```

The secrets command uploads only the allowlisted Worker settings, never prints their values, and preserves blank optional keys to disable AI/web tools. Persona Markdown is bundled; edit `personas/fourth-mirror.md` and redeploy to change it. `AI_SYSTEM_PROMPT` can override it within Workers' per-variable size limit. `AI_PERSONA_FILE` and `AI_HISTORY_FILE` are Node settings; Workers uses bundled text and SQLite.

`npm run cloudflare:control -- verify` explicitly checks the real AI and search providers with fixed synthetic inputs. It does not read conversations or post Discord messages. It uses normal provider billing and is not part of the recurring health monitor.

Commands are registered for the application/server in `.env.cloudflare`. The original `commands:deploy` script still uses `.env`; use **cloudflare:commands** for the selected hosted profile. Re-register after changing command definitions, not after ordinary code changes. The existing production commands were verified and did not need re-registration during cutover.

Wait for `configured`, `running`, `accepting`, and `ready` to become true, `blocked` to be null, and `lastAckAt` to advance. `/status` is private and contains health/counts, not chat text or API keys. A fatal token, intent, or application-ID error blocks automatic reconnection. Fix the setting/Discord portal configuration, upload secrets if needed, then explicitly start again.

For a first deployment on another account, run `npm run cloudflare:deploy`, save its HTTPS URL as `CLOUDFLARE_BOT_URL`, and upload secrets. `CLOUDFLARE_WORKER_NAME` defaults to a staging name in the generated settings; scripts use it consistently for deployment and secrets. The first `workers.dev` hostname may briefly need DNS/certificate provisioning. Keep TLS verification enabled.

## Live validation

In Discord, select the configured application when trying the commands:

1. Check `/ping` and `/help`.
2. Start `/chat` in a regular text channel. Confirm Personal mode creates a private thread and Group mode creates a public thread. The initiating member is added in either mode; other members with access to the parent channel can join a public group themselves.
3. Send ordinary text, then a question referring to the earlier reply. Test web search if enabled. Check that replies include actual source links.
4. Test an attachment and `/reset`. Confirm personal chats accept only their owner, while group chats accept other members who mention or reply to the bot. Only the group creator can reset shared context.
5. Ask for a longer reply and run `npm run cloudflare:update` while it is processing. The drain should let the accepted reply finish and save before replacement. Confirm earlier context still works after the bot reconnects.
6. Mention the bot with a question in a regular channel. Confirm it replies there without creating a thread, can use the preceding 30 messages and their direct reply targets (including older messages), and ignores a follow-up without an explicit mention. Duplicate targets should appear only once, and further reply chains or other channels should not be fetched. One-off exchanges must not appear in history exports. Check that it can still answer when channel history cannot be read.
7. Check `/beta latest` and a `/beta ask` inquiry about a named character. Alerts are initially disabled. A member with Manage Server can choose a beta/spoiler channel using `/beta alerts channel:`, provided the bot can view it, send messages, and embed links. Polling shares the existing watchdog alarm and does not use AI. The private `POST /beta/verify` control route checks source access without enabling alerts or sending Discord messages.

Then monitor a full day:

```sh
npm run cloudflare:soak
```

The monitor writes a private report in `data/`. It leaves an initial **16-minute interval without health polling**, then samples readiness/heartbeat state each minute. This checks recovery without status traffic waking the object. The current monitor was launched in the background; `data/cloudflare-monitor.json` records its PID and log path. A temporary macOS `caffeinate` process prevents idle sleep while it runs. The hosted bot runs independently of this machine.

Reports mark completion explicitly. Stopping the monitor early does not count as a pass, and missed sampling windows (including laptop sleep) mark the run unhealthy rather than silently passing. Inspect Cloudflare's duration, SQL, request, CPU, and memory metrics too: status monitoring cannot prove quota usage.

Use `-- --seconds 120 --quiet-seconds 0 --interval 10` for a short monitor smoke test, not as a replacement for the full run. Provider calls used for live chat retain their usual billing.

## Frequent updates and backup

```sh
npm run cloudflare:update
```

This checks the Node code and Workers adapter, confirms deployment access, closes admission, drains accepted handlers, exports a private backup to `data/backups/`, deploys with immediate Durable Object code activation, and starts again. Immediate activation happens only after the drain, avoiding Cloudflare's default five-minute deferral for an active object. Handler network work is bounded to fit the control request's shutdown window. Use this command for running bots; `cloudflare:deploy` refuses to replace a bot reporting active/running work.

Messages arriving during maintenance receive a resend instruction when possible. Platform restarts can still interrupt an outstanding turn. A persistent journal suppresses replayed message IDs and sends a recovery notice instead of automatically repeating a paid model call. Discord nonce enforcement also reduces duplicate delivery within Discord's documented nonce window. Exactly-once external effects are not guaranteed.

For a manual backup:

```sh
npm run cloudflare:control -- drain
npm run cloudflare:control -- export data/backups/manual-history.json
npm run cloudflare:control -- start
```

Export requires a stopped, drained bot. Existing backup files are never overwritten. History exports have the same version-1 format as Node's `data/chats.json`. Journal entries and interaction credentials are excluded. The journal retains bounded terminal entries; completed interaction tokens are removed immediately.

## Future cutover or rollback

The current bot has already been moved at the owner's request. A separate test bot is not a prerequisite. The procedure below applies to a future migration or another profile.

1. Drain staging and leave it stopped. Two permanently active objects would exceed the shared free duration allowance.
2. Keep `.env.cloudflare` for staging. Run `CLOUDFLARE_SETTINGS_FILE=.env.cloudflare.production npm run cloudflare:setup -- --copy-providers` to generate a separate private profile and admin secret. In that file, set `CLOUDFLARE_WORKER_NAME=fourth-mirror` and the original bot/application/guild IDs. Leave its URL empty until the first production deployment. Set `CLOUDFLARE_SETTINGS_FILE=.env.cloudflare.production` for every production command.
3. Deploy the production Worker **stopped**, record its URL, and upload its secrets. Keep the Durable Object class, singleton name `bot`, namespace, and migration lineage stable on later updates.
4. Stop the original Node bot, then take a consistent copy of its configured history file. Do not run the original and hosted bot with the same token together.
5. Import that snapshot into the empty production destination before starting it:

```sh
CLOUDFLARE_SETTINGS_FILE=.env.cloudflare.production npm run cloudflare:control -- import data/chats.json
CLOUDFLARE_SETTINGS_FILE=.env.cloudflare.production npm run cloudflare:control -- start
CLOUDFLARE_SETTINGS_FILE=.env.cloudflare.production npm run cloudflare:control -- status
```

Import validates the whole snapshot, enforces the existing 100-session/20-message/24,000-character bounds, rejects duplicate thread IDs, and refuses a nonempty destination. It does not delete or overwrite the source file. Back up an occupied destination rather than attempting an overwrite. Use the same Discord server as the source history.

To revert to Node, drain the Worker, export its latest history, put the export at Node's history path, and restart Node. Keep only one runtime using the production token. Leave staging stopped when production is active.

## Local verification

```sh
npm run cloudflare:check
```

This includes the existing Node tests/build, Workers type checking, helper tests, production bundle validation, and integration tests using local workerd and synthetic Discord/model/search services. Test-only crash and inspection endpoints are excluded from the deployed bundle. The earlier `cloudflare:probe` remains as the smaller feasibility experiment. Local checks do not replace the live Discord and day-long quota tests.

The live test found that a `fetch` abort signal remains attached to an upgraded WebSocket in the deployed runtime. The adapter now clears its handshake deadline as soon as the upgrade completes, and regression tests cover both a stalled handshake and an established socket surviving that deadline. The corrected production connection remained stable through subsequent heartbeat acknowledgements.
