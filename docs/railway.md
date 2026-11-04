# Deploy to Railway

Run one always-on Railway service with one persistent volume. The bot connects to Discord itself; it does not need a public domain, HTTP port, or interactions endpoint.

## 1. Connect the repository

Commit and push the bot to a GitHub repository, including `Dockerfile`, `.dockerignore`, and `personas/`. In Railway, create a project, add a service from that repository, and select your production branch. Keep the service root at the repository root.

Railway [detects the Dockerfile](https://docs.railway.com/builds/dockerfiles). It installs dependencies from the lockfile, runs `npm run check` (types, tests, and build), and packages the compiled code, production dependencies, and persona files. A failed check fails the image build.

Leave custom build and start commands empty so the Dockerfile controls them. Its start command runs Node directly so shutdown signals reach the bot. No local `.env` or chat history is copied into the image.

## 2. Add a volume and variables

Attach a persistent volume to the bot service with the mount path **`/data`**. In the service's **Variables** settings, enter your real values:

```dotenv
DISCORD_TOKEN=your-bot-token
DISCORD_APPLICATION_ID=your-application-id
DISCORD_GUILD_ID=your-server-id

AI_API_KEY=your-provider-api-key
AI_MODEL=your-provider-model-name
AI_BASE_URL=https://your-provider.example/v1
AI_HISTORY_FILE=/data/chats.json

RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120
RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0
```

Use the same AI provider settings that work locally. Copy any other overrides you use, such as `AI_TOKEN_LIMIT_PARAM`, `AI_MAX_OUTPUT_TOKENS`, `AI_REASONING_EFFORT`, or `AI_SYSTEM_PROMPT`. If you use web search, also copy `WEB_API_KEY` and any `WEB_BASE_URL` override. Leaving `AI_API_KEY` unset disables AI chat. Leaving `AI_PERSONA_FILE` and `AI_SYSTEM_PROMPT` unset uses the bundled persona; custom persona files must also be included under `personas/` in the repository.

`AI_HISTORY_FILE` must point inside the mounted volume. The default relative `data/chats.json` would be `/app/data/chats.json` in this image, which is outside `/data` and would be lost on deployment. See [Railway volumes](https://docs.railway.com/volumes).

A new volume starts empty. Existing local history is not uploaded with the code. To keep those conversations, stop the local bot, copy `data/chats.json` into the volume as `chats.json` using Railway's [volume file tools](https://docs.railway.com/cli/volume), and restart the Railway bot so it loads that file. Avoid overwriting history while either bot is accepting messages.

## 3. Configure the service

In the service settings, use:

| Setting | Value |
| --- | --- |
| Replicas | One, in one region |
| Serverless / sleeping | Disabled |
| Restart policy | On Failure, with 10 retries |
| Custom build command | Empty; the Dockerfile runs the checks and build |
| Custom start command | Empty; the Dockerfile starts Node directly |
| Healthcheck path | Empty; this bot has no HTTP server |
| Public domain / networking | No public endpoint needed |

The draining variable allows 120 seconds between SIGTERM and SIGKILL. The bot stops accepting new messages and commands, waits for accepted handlers (including AI replies, delivery, and history saves), then disconnects. It forces exit after 115 seconds if work gets stuck. A plain AI turn has a 45-second timeout; web-enabled turns can take up to 90 seconds, leaving time for delivery and saving. See [Railway deployment teardown](https://docs.railway.com/deployments/deployment-teardown).

Keep exactly one bot process for this Discord token, including on your local machine. Multiple processes can reply to the same message and keep conflicting histories. Use a separate Discord application and token for development or preview environments.

## 4. Deploy and verify

Apply the pending Railway changes and deploy. Stop your local `npm run dev` or `npm start` process before bringing the hosted bot online.

Open the deployment logs and look for `Logged in as ...`. An Active deployment alone does not confirm Discord login because there is no HTTP readiness check.

If commands have not been registered yet, run this locally with your existing `.env`:

```sh
npm run commands:preview
npm run commands:deploy
```

Registration updates Discord's command list; it does not start another bot connection. Alternatively, run this once in the deployed container's shell, where Railway supplies the variables:

```sh
node dist/scripts/deploy-commands.js
```

Test `/ping`, then `/chat` and a normal text reply in its private thread. For AI chat, Discord's **Message Content Intent** and the thread permissions in the [main setup guide](../README.md#create-and-invite-the-bot) must already be enabled.

Send a memorable message in a chat, redeploy, then continue in that same thread. This verifies that the mounted history survives updates. Enable volume backups if you want recovery from accidental data changes.

## Updating the bot

Railway's [GitHub autodeploys](https://docs.railway.com/deployments/github-autodeploys) build and deploy commits pushed to the connected branch. Edit and test locally, then push when ready. Persona changes are included in the image and take effect when the new bot starts.

Run `commands:deploy` again only after changing slash-command definitions (names, descriptions, options, or permissions). Handler changes and persona changes only need a deployment.

Expect a brief interruption during updates: Railway [stops the old deployment before mounting its volume on the new one](https://docs.railway.com/volumes/reference#caveats). Messages arriving during shutdown or while the bot is offline may need to be sent again. Saved conversations stay on the volume. Rolling back code does not roll back volume contents; future history format changes need a compatible migration.

## Optional local container check

With Docker running:

```sh
docker build -t fourth-mirror .
docker run --rm --env-file .env \
  -e AI_HISTORY_FILE=/data/chats.json \
  --mount type=volume,source=fourth-mirror-data,target=/data \
  --stop-timeout 120 \
  --name fourth-mirror fourth-mirror
```

Stop other bot instances first. This uses a new Docker volume, separate from local `data/`. From another terminal, `docker stop --time 120 fourth-mirror` exercises graceful shutdown.
