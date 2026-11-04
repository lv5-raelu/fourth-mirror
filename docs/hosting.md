# Host on a Linux VM

The bot needs a continuously running process and persistent chat storage. A Linux VM can provide both. The included `Dockerfile` and `compose.yaml` work on an Arm or AMD64 Ubuntu server, including a machine you already own.

## Choosing a free cloud host

**Oracle Cloud Always Free can host the current Node bot, but available hardware is a prerequisite.** Both eligible shapes returned out-of-capacity errors in AD-1 during this setup. The [Cloudflare investigation](cloudflare.md) covers an alternative that requires adapting the runtime. For a VM, select resources within the Always Free allowance, rather than relying on introductory trial credits. AI and web-search provider usage is billed separately from hosting.

Oracle currently includes Always Free compute and 200 GB of combined boot/block storage in your home region. Its A1 allowance is equivalent to 2 OCPUs and 12 GB RAM across eligible VMs. A suggested starting configuration for this bot is one A1 VM with **1 OCPU, 2 GB RAM, and a 50 GB boot disk**, using an eligible Ubuntu image. Check that the console identifies the configuration as within the free allowance before creating it. See [Oracle's Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

There are material limits: free compute capacity might be unavailable, and Oracle may reclaim idle free instances after a seven-day utilization assessment. A lightly used bot could qualify as idle. This is a best-effort free host, not guaranteed uninterrupted hosting. Keep history backups outside the VM. Oracle also requires a supported card for identity verification and may place temporary authorization holds. See the [free-tier FAQ](https://www.oracle.com/cloud/free/faq/) and [idle instance policy](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm#compute).

Other options checked:

| Option | Fit for this bot |
| --- | --- |
| A computer or Raspberry Pi you own | Works with this Compose setup while powered on and connected. Electricity and internet are still your costs. |
| Google Cloud free VM | Free compute has region and usage limits. A conventional setup with an external IPv4 address incurs a separate IP charge; do not assume the whole VM setup costs $0. See [free-tier limits](https://docs.cloud.google.com/free/docs/free-cloud-features#free-tier) and [IP pricing](https://cloud.google.com/vpc/network-pricing#ipaddress). |
| Render / Koyeb free services | Sleeping and lack of persistent disks make these a poor match for the current Gateway worker and local history. See [Render limits](https://render.com/docs/free) and [Koyeb free-instance limits](https://www.koyeb.com/docs/reference/instances). |
| Railway | Convenient deployment, but only a small monthly free resource allowance. See [pricing](https://railway.com/pricing) and the [optional Railway guide](railway.md). |

## 1. Create the VM

For Oracle, sign up through its [Free Tier page](https://www.oracle.com/cloud/free/) and create an eligible VM in your home region. Save the SSH key and public IP. Choose an Ubuntu image and a public subnet with outbound internet access.

Allow SSH access from your IP. The bot needs outbound HTTPS/WebSocket access to Discord and your providers; it does not need an incoming HTTP port, domain, or reverse proxy. If your chosen free shape is out of capacity, try another availability domain in the home region or wait. A paid upgrade is not part of this setup.

### If Oracle reports out of capacity

Keep the fault domain unselected so Oracle chooses it. If A1 is unavailable, the other free option is `VM.Standard.E2.1.Micro` under **Specialty and previous generation** in the shape selector. It has 1 GB RAM and needs an AMD64/x86-64 Ubuntu image instead of an Arm image. The container supports either architecture; a small VM may need swap or an image built on another machine.

If both free shapes fail with automatic fault-domain selection, there is no reliable form change that creates available hardware. Retry later; Oracle provides no guaranteed time for capacity to return. The free compute allowance is tied to the home region, so selecting another region does not move that allowance. See [Oracle's capacity troubleshooting](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/troubleshooting-out-of-host-capacity.htm) and [free-compute rules](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

Continue below once a free instance is running.

Connect using the SSH command shown by the cloud console, usually with the `ubuntu` user. Install Git and [Docker Engine with the Compose plugin](https://docs.docker.com/engine/install/ubuntu/) using Docker's Ubuntu instructions. On the server, verify:

```sh
git --version
sudo docker version
sudo docker compose version
sudo systemctl enable --now docker
```

## 2. Copy the repository and configuration

Commit and push the bot's code, including `Dockerfile`, `compose.yaml`, and `personas/`. On the VM:

```sh
git clone YOUR_REPOSITORY_URL fourth-mirror
cd fourth-mirror
cp .env.example .env
chmod 600 .env
mkdir -p data
chmod 700 data
```

Edit `.env` on the VM with your existing Discord, AI, and optional web settings. You can also securely copy your local `.env` over SSH. The file stays outside Git and the image. Leave `AI_PERSONA_FILE` empty to use the included persona. Compose overrides `AI_HISTORY_FILE` to `/data/chats.json` and mounts the server's `./data/` there.

To preserve existing conversations, stop your local bot and copy its `data/chats.json` into the server's `data/` directory **before starting the hosted bot**. Set the uploaded file's permissions to `600`. Otherwise, the hosted bot starts with empty history and you should create new `/chat` threads. Keep one bot process per Discord token; use a separate Discord application for local development.

No `RAILWAY_*` variables are needed. Compose supplies the two-minute shutdown window itself.

## 3. Build and run

From the repository directory on the VM:

```sh
sudo docker compose up -d --build
sudo docker compose logs --tail=100 -f bot
```

The Dockerfile runs type checking, tests, and the build before producing the image. Look for `Logged in as ...`, then try `/ping` and an AI conversation in Discord. Press Ctrl+C to stop following logs; the bot continues running in the background. Compose restarts it after a crash or server reboot unless you explicitly stop it. Docker's [service settings](https://docs.docker.com/reference/compose-file/services/) describe the restart and shutdown behavior.

If slash commands have not been registered, preview and deploy them from the running container:

```sh
sudo docker compose exec bot node dist/scripts/deploy-commands.js --dry-run
sudo docker compose exec bot node dist/scripts/deploy-commands.js
```

This updates this application's command list in the configured Discord server. Run it again after changing command names, descriptions, options, or permissions.

## Frequent updates

Push changes from your development machine. Then, in the VM's repository directory:

```sh
git pull --ff-only
sudo docker compose up -d --build
sudo docker compose logs --tail=100 bot
```

Compose builds the new image before recreating the bot container. History stays in the host's `data/` directory. During replacement the old process can finish accepted work for up to 115 seconds, within Compose's two-minute limit. Expect a brief interruption while Discord reconnects. Messages arriving while the bot is stopping or offline may need to be resent.

After changing only `.env`, recreate the container to load the new variables:

```sh
sudo docker compose up -d --force-recreate
```

Periodically use `sudo docker compose build --pull` before `up -d` to refresh the base Node image. See [Compose in production](https://docs.docker.com/compose/how-tos/production/).

## Back up history

The mounted directory survives container replacements, but it is still on the VM's disk. Keep a copy outside that VM, especially on a free host that can reclaim compute.

To take a consistent backup, stop the bot briefly, archive `data/` outside the repository, and start it again:

```sh
sudo docker compose stop bot
(umask 077; sudo tar -czf - data/ > "$HOME/fourth-mirror-history.tar.gz")
sudo docker compose start bot
```

Download that archive over SSH to another machine. The container writes history with owner-only permissions; use `sudo` when reading or backing it up on the host. Protect the archive as private conversation data.
