# Automatic deployment from main

`.github/workflows/ci-cd.yml` checks pull requests and pushes to `main`. After checks pass for a main commit, GitHub Actions updates the production Cloudflare Worker, using the same drain, history backup, deployment, and Gateway health checks as a local update.

## Behavior

- The `Checks` job installs the lockfile dependencies on Node 24 and runs `npm run cloudflare:check`: Node and Workers type checks, tests, integration tests, and builds. These use synthetic credentials and network mocks.
- Production deployment runs only for a `main` push or a manual workflow run targeting `main`, after that exact commit passes `Checks`. Pull requests receive no deployment secrets.
- Deployments are serialized. A newer main push does not cancel an active deployment after the bot has been drained. An older queued run skips deployment when it sees that main has advanced.
- Deployment validates configuration and Cloudflare access before draining the bot. It finishes accepted work, exports and encrypts a recovery backup, deploys with immediate Durable Object code activation, starts the Gateway, and waits for readiness and a heartbeat acknowledgement.
- A deployment failure before the new code is installed requests a restart of the previous version. A new version that cannot become healthy fails visibly and reports that its configuration needs attention; the workflow does not repeatedly reconnect or silently claim a successful deployment.
- The checked-in workflow pins its third-party actions to commit SHAs. Installation steps run before deployment credentials are supplied.

The workflow can also be started from **Actions → CI and deploy → Run workflow**, selecting `main`. To roll back code through the same process, revert the relevant commit on main. Slash-command registration and Worker secret rotation remain explicit operations, rather than recurring steps in every code deployment.

## Production environment

Repository **Settings → Environments → production** is restricted to the `main` branch. It has no reviewer or wait-time gate, allowing successful main updates to deploy automatically.

| Type | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | A Cloudflare deployment token for the production account, using the Edit Cloudflare Workers template. |
| Secret | `CLOUDFLARE_ADMIN_TOKEN` | The bot's existing private control token, matching `ADMIN_TOKEN` on the Worker. |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | The production Cloudflare account ID. |
| Variable | `CLOUDFLARE_WORKER_NAME` | `fourth-mirror` for the current deployment. |
| Variable | `CLOUDFLARE_BOT_URL` | The existing production HTTPS Worker URL. |
| Variable | `HISTORY_BACKUP_PUBLIC_KEY` | The RSA public key used to encrypt CI recovery backups. |

Cloudflare's [GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) explains API-token creation and account scoping. GitHub uses this deployment token rather than a laptop's interactive Wrangler OAuth session. Existing Discord, model, and web-provider credentials remain stored as Cloudflare Worker secrets; the pipeline does not upload or rotate those credentials.

`npm run cloudflare:update -- --ci` is reserved for this workflow. It requires GitHub's main-event context, a matching checked commit SHA, deployment settings, and a valid backup key. It reuses the successful `Checks` job instead of running the same full suite twice. The regular `npm run cloudflare:update` still runs the full suite locally and uses the laptop's normal Wrangler authentication.

## Encrypted recovery backups

Each deployment exports a backup before replacing the code. The CI runner encrypts the validated history with a fresh AES-256-GCM key and wraps that key using the RSA public key. The encrypted `.enc` file is saved as a GitHub Actions artifact for seven days, including when a later deployment step fails. Plaintext history is not uploaded as an artifact or printed in logs.

The matching private key for this workspace is stored at `data/ci-backup-private.pem`, with owner-only permissions and excluded from Git. GitHub has only the public key. Keep a private copy of the recovery key: encrypted artifacts cannot be recovered without it. Ordinary code deployment and live SQLite history do not depend on having that private key on the runner.

For a new installation, generate a recovery key once:

```sh
node cloudflare/scripts/backup-key.mjs
gh variable set HISTORY_BACKUP_PUBLIC_KEY --env production < data/ci-backup-private.pem.pub
```

The generator refuses to overwrite existing key files. To rotate the key, choose a different `--output` path and retain the previous private key for older artifacts. Updating the GitHub public-key variable changes encryption for future backups.

To recover a downloaded artifact:

```sh
node cloudflare/scripts/backup-recover.mjs \
  --input /path/to/cloudflare-backup.json.enc \
  --key data/ci-backup-private.pem \
  --output data/recovered-history.json
```

Recovery validates the decrypted data and writes a new private file without overwriting existing data. It does not import that history or change the live bot. Follow the [Cloudflare recovery guide](cloudflare-deployment.md#future-cutover-or-rollback) when an actual import is needed.

## Troubleshooting

The Actions run shows separate check and deployment jobs. A missing production setting or invalid deployment token fails before drain. If Cloudflare authorization fails, verify the token's account and Worker deployment permissions. If checks fail, production is not touched. If a run is skipped because main advanced, the newer main run handles deployment.

Do not run a manual laptop deployment concurrently with the Actions deployment. The GitHub concurrency lock serializes Actions jobs, while an independently invoked local command is outside that lock.
