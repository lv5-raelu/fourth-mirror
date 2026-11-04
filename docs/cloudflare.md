# Cloudflare feasibility investigation

Investigated on **2026-10-30**. The Workers adapter and graceful update workflow are implemented. At the owner's request, the existing bot is now running on the production Worker with its saved conversation imported. Live authentication, Gateway readiness/heartbeats, thread permissions, AI, and web search passed. The 24-hour monitor is running and has not yet completed. Follow the [deployment guide](cloudflare-deployment.md).

This approach avoids provisioning an Oracle VM, selecting a shape or availability domain, and configuring SSH/VCNs. It does not guarantee account approval, platform availability, or access to Discord and AI providers from Cloudflare's network.

## Implemented adaptation

Use **one Durable Object for the entire bot**, with a native outbound Discord Gateway WebSocket, a durable reconnect alarm, and SQLite rows for individual conversations and processed message IDs. Personal chats use private threads; groups use public threads and respond to mentions or replies. Keep the existing AI, persona, web tools, ownership checks, and conversation limits. An HTTP-only slash-command bot would require changing the current conversation behavior.

Reuse `ChatService` and the provider adapters. Their storage contract is now independent of the Node file store. Replace filesystem persistence with SQL and bundle the persona as text. The current Node entry point, Docker image, filesystem history, and process shutdown handling are not a Workers deployment package; this investigation does not establish that Discord.js can run unchanged.

Store each thread separately: all 100 transcripts together could exceed Cloudflare's **2 MB per row/value** limit. Retain the existing history bounds and add bounded retention for the message journal. See [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Can hosting stay at $0?

Workers Free supports SQLite-backed Durable Objects. Current published allowances include:

| Resource | Free allowance | Implication |
| --- | --- | --- |
| Object duration | 13,000 GB-s/day | One continuously active 128 MB object is approximately **11,059 GB-s/day**, about **85%** of the allowance. |
| Object requests | 100,000/day | Includes alarm invocations and metered incoming socket messages. |
| SQL reads / writes | 5 million / 100,000 rows/day | Persisting Gateway sequences and message journals consumes this allowance too. |
| Stored data | 5 GB/account | Bound both transcripts and diagnostic/journal retention. |

The duration estimate uses Cloudflare's decimal billing example: 86,400 seconds × 0.128 GB = 11,059.2 GB-s. It is **not measured production usage**. Outbound sockets cannot hibernate. Account usage is shared: a second permanent active object would exceed the daily duration allowance. Short deployment overlap has some headroom. Keep production and long-running staging workloads separate or within the combined budget.

On Workers Free, exhausting an allowance causes failures; daily limits reset at 00:00 UTC. AI and web-provider charges remain separate. See [current pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Evidence from this repository

Run the isolated proof:

```sh
npm ci
npm run cloudflare:probe
```

It dry-runs Wrangler's deployment build, then runs the result in local **workerd through Miniflare**. The adapted bundle is approximately **1 MiB uncompressed** (164 KiB gzip for reference), below the current [64 MiB uncompressed Workers limit](https://developers.cloudflare.com/workers/platform/limits/). Dependencies are pinned to Wrangler 4.156.0 and its matching Miniflare version.

The proof tests real shared chat/provider code against synthetic Gateway, model, web-search, and Discord REST services. It checks heartbeat ACKs, reconnects, stale-session recovery, owner/server filtering, citations, mention suppression, persistent transcripts, duplicate suppression across crashes, unattended alarm recovery, interrupted model requests, provider failure, fatal intent errors, and reset/stop persistence after replacing the whole local runtime.

It caught a real compatibility issue: Workers rejects `fetch` with `redirect: "error"`. The web adapter now uses manual redirects and rejects redirect responses without following them. Its Node redirect test still passes. `Buffer` is also imported explicitly.

The proof never loads `.env`, uses only synthetic credentials, and routes outbound requests to local mocks. Its default deployment settings disable its entry point; **do not deploy it as the bot**. Local success does not prove real-edge networking, live quota consumption, 24-hour uptime, or successful authenticated Discord sessions.

## Verification status

1. **Implemented and tested locally:** all four commands, interaction deferral, private-thread creation/membership, effective channel permissions, attachment explanations, REST rate limits, settings validation, and Gateway heartbeat/resume/invalid-session/Identify-limit behavior. [Discord's Gateway specification](https://docs.discord.com/developers/events/gateway) is the protocol reference.
2. **Implemented and tested locally:** reconnect alarms/backoff, private health reporting, bounded journals, completed-token cleanup, interrupted-turn notices, and cleanup of unfinished threads. The production adapter records the uncertain outcome and asks the user to resend; it does not automatically repeat the paid call.
3. **Implemented and tested locally:** private version-1 history import/export, validation before atomic import, overwrite protection, and a graceful drain before backups and deployment. Preserve namespace/singleton/migration identity. Stop the old bot before starting the replacement with the same token.
4. **Live progress:** the existing bot is authenticated and online, its saved thread is accessible with all required permissions, and real provider checks passed without posting test messages. A real graceful update also succeeded. Synthetic integration tests cover command/message handling and interrupted turns. The 24-hour idle/active run is in progress; actual daily resource usage and user-driven `/chat`/message checks remain to be observed. A separate test bot is optional; do not run a second permanent active actor on the same free allowance.

Cloudflare can replace objects and disconnect sockets during deployments. There is no dependable process shutdown hook. Operations prevent eviction only for their documented window; heartbeats and durable alarms must recover without incoming user traffic. Persist state before relying on it. A deployment can interrupt an outstanding provider call or Discord delivery, so uninterrupted replies and exactly-once external effects are not guaranteed. See [object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) and [WebSocket behavior](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

The initial investigation used local synthetic services. The user's Cloudflare account was then authenticated and staging transport verified. A short HTTPS failure during initial hostname provisioning cleared. During the authorized existing-bot cutover, the live runtime exposed a WebSocket lifetime bug: a handshake abort timer also closed an established socket. The adapter now clears that timer after upgrade; regression tests pass, and the deployed connection survived subsequent heartbeat acknowledgements. The [temporary preview flow](https://developers.cloudflare.com/workers/platform/claim-deployments/) was not used. Staging remains stopped; production uses the existing Discord application.
