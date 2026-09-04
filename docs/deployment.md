# Deploying OpenTeam

This guide covers installing the released OpenTeam stack on a machine you control, choosing how to
reach it, connecting the apps, and keeping it updated. To run from source instead, see
[Develop from source](../README.md#develop-from-source) in the README.

- [Requirements](#requirements)
- [Install](#install)
- [Choose how to reach it](#choose-how-to-reach-it)
- [Owner account](#owner-account)
- [Connect a model provider](#connect-a-model-provider)
- [Connect the apps](#connect-the-apps)
- [Manage the stack](#manage-the-stack)
- [Update](#update)
- [Backups and restore](#backups-and-restore)
- [Security notes](#security-notes)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)

## Requirements

| Need | Details |
| --- | --- |
| Host | An x64 or arm64 machine. A small Linux VM is the usual choice. |
| Docker | Docker with Compose 2.20 or newer. The installer checks both. |
| CLI runtime | None. The installer downloads a native CLI binary from GitHub Releases. |
| Memory | 8 GB recommended. The installer warns below that. |
| Disk | 8 GB free recommended at install. Updates need at least 4 GB free. |
| Local ports | `8787` and `6200-6299` must be free on `127.0.0.1` before install. |
| Inbound ports | TCP 80 and 443 for public HTTPS. The API port for public HTTP or private network. None otherwise. |

The stack is four long-running containers (PostgreSQL, server, worker, computer) plus a few
one-shot jobs that sync the database schema and fix volume permissions. Public HTTPS mode adds a Caddy
container for certificates.

## Install

```sh
curl -fsSL https://openteam.so/install | sh
```

The installer detects the operating system and architecture, downloads the matching native CLI
from the latest GitHub release, verifies it against `SHA256SUMS`, installs it to
`~/.local/bin/openteam`, and starts the guided setup. Set `OPENTEAM_BIN_DIR` to choose another CLI
location, or `OPENTEAM_VERSION` to install a specific release.

The examples below use `openteam ...`. The installer places the CLI in `~/.local/bin`; add that
directory to `PATH` if your shell does not already include it.

What `install` does, in order:

1. Runs `doctor`. Any failed check stops the install.
2. Downloads the release Compose file from GitHub for the requested version (latest by default),
   checks its SHA-256 sum, and verifies its Sigstore signature against this repo's release
   workflow. Every OpenTeam image in that file is pinned by digest.
3. Creates the install directory and writes `compose.yaml`, a generated `.env`, and
   `installation.json`. All files are private to your user.
4. Pulls the images.
5. Starts the guided setup described in the next three sections, then brings the stack up and
   waits for the health endpoint to report `ready`.

The install directory is `~/.openteam` by default. Set `OPENTEAM_HOME` or pass `--dir <path>` to
change it. On Linux with `XDG_CONFIG_HOME` set it becomes `$XDG_CONFIG_HOME/openteam`, and on
Windows it is `%LOCALAPPDATA%\OpenTeam`.

`.env` holds four generated secrets: the PostgreSQL password, the control token the services use
to talk to each other, the auth secret that signs sessions, and the proxy secret. Your password and
provider credentials are never written there.

Running `install` again on an existing install does not reinstall. It resumes setup if the owner
account was never created, and otherwise just starts the stack. Pass `--no-setup` to install and
start without the wizard.

## Choose how to reach it

The first setup stage asks how the apps will reach the server. You can change it later with
`openteam setup`.

| Mode | Use when | Ports opened | You must |
| --- | --- | --- | --- |
| **Public HTTPS** (default) | The server has a public IP and you own a domain | 80 and 443 on all interfaces. API and screen viewers stay on loopback. | Point an A or AAAA record at the host and allow inbound TCP 80 and 443. |
| **Existing HTTPS proxy** | You already run nginx, Caddy, Traefik, or a load balancer | Nothing. API binds to `127.0.0.1`. | Proxy to `http://127.0.0.1:8787` and forward WebSocket upgrades. |
| **Public HTTP** | Quick test on a bare IP, no TLS | API port on all interfaces. Viewers stay on loopback. | Open the API port. Confirm the cleartext warning. |
| **Private network** | The host is only reachable over a LAN or VPN such as Tailscale | API port and `6200-6299` on all interfaces | Nothing if a private IP is detected. |
| **This machine only** | Server and desktop app on the same computer | Nothing beyond loopback | Nothing. Use an SSH tunnel for remote access. |

Notes per mode:

- **Public HTTPS.** Enter a real domain, not an IP. The bundled Caddy container gets and renews
  the certificate automatically, so the host needs no existing certificate. Setup refuses to
  switch into this mode if something else already listens on 80 or 443.
- **Existing HTTPS proxy.** Setup prints the local upstream to use. Configure the proxy to
  replace, not append to, the inbound `X-Forwarded-*` headers. A proxy on the same host is
  trusted automatically. A proxy on another host can send the header
  `X-OpenTeam-Proxy: <OPENTEAM_PROXY_SECRET from .env>` to be trusted for client IPs.
- **Public HTTP.** Your password and session tokens travel unencrypted. The iPhone app refuses
  cleartext connections to public addresses, so only the desktop app works here.
- **Private network.** Setup prefers a Tailscale address, then a LAN address. The screen viewer
  ports have no login of their own, so keep this mode off untrusted networks.

After applying, setup checks DNS, the public endpoint, and certificate expiry for the three
internet-facing modes. If the stack fails to come up, setup restores the previous `.env`.

## Owner account

OpenTeam has exactly one account. Setup asks for a username (3 to 30 characters, lowercase
letters, digits, `_` and `.`) and a hidden, confirmed password of 8 to 128 characters. The
password is hashed inside PostgreSQL by Better Auth and never touches `.env`.

Change it later with:

```sh
openteam account update                 # prompts for both
openteam account update --username bob  # username only
openteam account update --password      # password only (prompted, never on the command line)
openteam password reset                 # same as --password
```

Every credential change signs out all desktop and iPhone sessions.

## Connect a model provider

The last setup stage picks the provider and model that all bots use. You can change this at any
time from the desktop app (**Settings → Server**) or the CLI, without restarting anything.

| Provider | Sign in with | Default model |
| --- | --- | --- |
| `openai-codex` (default) | ChatGPT Plus or Pro account (OAuth) | `gpt-5.5` |
| `anthropic` | Claude Pro or Max account (OAuth), or an Anthropic API key | `claude-sonnet-5` |
| `openai` | OpenAI API key | `gpt-5.5` |
| Custom | Any OpenAI-, Anthropic-, or Google-compatible endpoint with an API key | Your choice |

```sh
openteam provider list                              # providers, model counts, sign-in state
openteam provider login anthropic --auth oauth      # Claude Pro/Max
openteam provider login anthropic --auth api-key    # Anthropic API key
openteam provider login openai --auth api-key       # OpenAI API key
openteam model list anthropic                       # models with context window and capabilities
openteam model use anthropic claude-sonnet-5 --thinking high
```

OAuth offers a browser flow and a device-code flow for headless hosts. API keys are read from a
hidden prompt or stdin, never from arguments or `.env`. Credentials live inside the computer
container's private volume, owned by the runtime user. Bot shells run as a different user and
cannot read them.

Anthropic OAuth is reported by the runtime as a Claude Pro/Max subscription sign-in. Its current
integration bills third-party agent traffic as paid extra usage rather than included plan usage.

To add a custom endpoint:

```sh
openteam provider add acme \
  --name "Acme AI" \
  --base-url https://ai.example.com/v1 \
  --api openai-responses \
  --model acme-pro \
  --reasoning
openteam model use acme acme-pro
```

`--api` is one of `openai-completions`, `openai-responses`, `anthropic-messages`, or
`google-generative-ai`. Remove a custom provider with `openteam provider remove <id>` after
selecting another one.

Until a provider is signed in, you can create bots and browse history, but no bot can run a turn.
The desktop app shows this as **Pi missing**.

## Connect the apps

**Desktop.** Download the installer for macOS, Windows, or Linux from the
[GitHub releases](https://github.com/raghavpillai/openteam/releases). On first launch enter the
server URL that setup printed, then sign in with the owner account. Closing the app never stops a
bot.

**iPhone.** The app in `apps/mobile` is built with Expo. App Store and TestFlight distribution is
not set up yet, so build it yourself with `bun --filter @openteam/mobile ios`. In the app, open
**Settings → Advanced** and enter the server URL. The phone must be able to reach the server over
HTTPS or a private network.

## Manage the stack

| Command | What it does |
| --- | --- |
| `openteam status` | Version, install directory, access mode, public URL, container list, health. Exits non-zero when unhealthy. |
| `openteam doctor` | Host, Docker, port, permission, and readiness checks. Exits `2` if any check fails. |
| `openteam start` | Start the stack and wait for health. |
| `openteam stop` | Stop the containers. Data is kept. |
| `openteam logs [--service server] [--follow] [--tail 200]` | Show or stream container logs. |
| `openteam setup [--advanced]` | Re-run the access, owner, and runtime wizard. Keeps the owner account and active sessions. |
| `openteam provider ...` / `openteam model ...` | Manage providers and the active model. See above. |
| `openteam account update` / `openteam password reset` | Change the owner credentials. |
| `openteam update [--version X]` | Upgrade the stack. See below. |
| `openteam uninstall [--purge]` | Remove the stack. See below. |

`openteam setup --advanced` adds four prompts: API port, time zone (IANA name such as
`America/New_York`), default reasoning effort, and the number of bot turns that can run at once.

If you need raw Compose access, use the same project settings the CLI uses:

```sh
docker compose --project-name openteam --project-directory ~/.openteam -f ~/.openteam/compose.yaml ps
```

## Update

From the CLI:

```sh
openteam update                    # latest release
openteam update --version 0.2.0    # a specific release
```

From the desktop app, open **Settings → Updates**. If the server runs on this machine in your own
install directory, the app runs its bundled copy of the CLI. If the server is elsewhere, enter an
SSH destination such as `owner@openteam-host`. The app uses your SSH agent and an existing
`known_hosts` entry, never a password. If SSH is not set up, the app shows the command to copy
instead. The desktop app updates itself separately from the same page.

What an update does:

1. Takes a lock so two updates cannot overlap.
2. Refuses downgrades and prereleases unless you pass `--allow-downgrade` or `--allow-prerelease`.
   Re-applying the current version needs `--force`.
3. Checks for 4 GB of free disk and that Docker accepts the new Compose file.
4. Downloads and verifies the new release, then pulls its images.
5. Stops the server, worker, and computer briefly and writes a PostgreSQL dump to
   `<install dir>/backups/`.
6. Starts the new release and waits until the health endpoint reports `ready` on the new version.

If startup fails, the updater restores the previous Compose file and `.env`, restores the database
dump if the schema sync had started, and restarts the old release. The last update job is recorded in
`<install dir>/update-state.json` for diagnostics.

Patch releases within a compatible protocol line are advisory. The apps show a blocking banner
only when the app, server, or API protocol falls outside the published compatibility window.

## Backups and restore

Everything OpenTeam needs lives in PostgreSQL plus five Docker volumes:

| Store | Holds |
| --- | --- |
| PostgreSQL (`openteam_postgres`) | Bots, chat history, runs, mailboxes, job queue, plugin state |
| `openteam_computer_home` | Provider credentials, Pi sessions, screen mappings, browser profiles |
| `openteam_agent_data` | Editable bot files: profiles, memory, routines, skills, transcripts |
| `openteam_assets` | Uploaded and generated attachments |
| `openteam_workspace` | The shared `/workspace` files |
| `openteam_box_store` | Snapshot blobs and their manifest |

They form one recovery set. Always back up and restore them together. For the cleanest backup,
stop sending messages and let active runs finish first.

**Back up a released install:**

```sh
D=~/.openteam
OUT=./openteam-backup-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT"
docker compose --project-name openteam --project-directory "$D" -f "$D/compose.yaml" \
  exec -T postgres pg_dump -U openteam -d openteam --format=custom > "$OUT/postgres.dump"
for v in computer_home agent_data assets workspace box_store; do
  docker run --rm -v "openteam_$v:/source:ro" -v "$(cd "$OUT" && pwd):/backup" alpine:3.22 \
    tar -czf "/backup/openteam_$v.tar.gz" -C /source .
done
```

Also copy `~/.openteam/.env`. It holds the database password and signing secrets the restored
data expects. For the dev stack, `sh scripts/backup.sh` in the repo does the same thing.

**Restore:**

```sh
D=~/.openteam; C="docker compose --project-name openteam --project-directory $D -f $D/compose.yaml"
openteam stop
$C up -d postgres
$C exec -T postgres dropdb -U openteam --force openteam
$C exec -T postgres createdb -U openteam openteam
$C exec -T postgres pg_restore -U openteam -d openteam < "$OUT/postgres.dump"
for v in computer_home agent_data assets workspace box_store; do
  docker run --rm -v "openteam_$v:/target" -v "$(cd "$OUT" && pwd):/backup:ro" alpine:3.22 \
    sh -c "find /target -mindepth 1 -delete && tar -xzf /backup/openteam_$v.tar.gz -C /target"
done
openteam start
```

Then check `openteam status`, open a bot, and confirm its history, memory, and workspace files are
back before sending new work.

The plain SQL dumps that `openteam update` writes can be restored with `psql` instead of
`pg_restore`.

## Security notes

- **Authentication is on by default.** `OPENTEAM_AUTH_MODE=required` makes every app sign in with
  the owner account. `disabled` removes all API authentication and gives any client full access.
  Only use it on a fully isolated network, never behind a proxy or on the internet.
- **Screen viewer ports have no login.** The `6200-6299` range serves live bot screens over noVNC.
  It stays on loopback in every mode except private network. Do not expose it further.
- **Secrets file permissions.** `doctor` fails if `.env` is readable by other users.
- **Credentials stay server-side.** Provider tokens live in the computer container's private
  volume. Bot shells run as a separate user that cannot read them, and the apps only ever receive
  connection status, never values.
- **Verified releases.** The CLI accepts a Compose file only if its signature was issued by this
  repository's release workflow for the matching version tag. `--allow-unsigned` skips that check
  and should not be used for production.

## Uninstall

```sh
openteam uninstall           # stop and remove containers, keep all data and configuration
openteam uninstall --purge   # also delete every volume, the install directory, and its backups
```

After a plain `uninstall`, `openteam start` recreates the same installation. `--purge` is
permanent: PostgreSQL, sessions, provider sign-ins, bot files, and workspace files are all gone.
Both prompt for confirmation unless you pass `--yes`.

## Troubleshooting

Start with:

```sh
openteam doctor
openteam status
openteam logs --service server --follow
```

Common problems:

- **Install fails on ports.** Something already uses `8787` or a port in `6200-6299` on loopback.
  Free it, or pick another API port with `openteam setup --advanced`.
- **Cannot switch to public HTTPS.** Another process holds port 80 or 443. Stop it, or use
  existing-proxy mode.
- **Public URL check fails.** DNS has not propagated, the firewall blocks 80/443, or the proxy is
  not forwarding WebSocket upgrades.
- **Desktop shows "Pi missing".** No provider is signed in. Run `openteam provider login`.
- **iPhone will not connect.** The server is on public HTTP. Switch to HTTPS or a private network.
- **Update refused.** Less than 4 GB free, a downgrade, or a prerelease. See the update flags
  above.
- **Another update is already running.** A previous update crashed and left `update.lock` in the
  install directory. If no update process is alive, delete it and retry.
