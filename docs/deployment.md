# Deploying OpenTeam

This guide covers installing the released OpenTeam stack on a machine you control, choosing how to
reach it, connecting the apps, and keeping it updated. To run from source instead, see the
[development guide](development.md).

- [Requirements](#requirements)
- [Install](#install)
- [Connection defaults](#connection-defaults)
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
| Host | An x64 or arm64 machine running Linux, macOS, or Windows. |
| Docker | A running Docker Engine for Linux containers, the Docker CLI, and Compose 2.20 or newer. The installer checks the CLI, daemon, and Compose. |
| CLI runtime | None. The installer downloads a native CLI binary from GitHub Releases. |
| Memory | 8 GB recommended. The installer warns below that. |
| Disk | 8 GB free recommended at install. Updates need at least 4 GB free. |
| Local ports | `8787` and `6200-6299` must be free on `127.0.0.1` before install. |
| Inbound ports | TCP 80 and 443 for public HTTPS. The API port for public HTTP or private network. None otherwise. |

On Linux, Docker Engine and Compose run directly on the host; Docker Desktop is optional. On
macOS and Windows, Docker Desktop supplies a Linux VM, the engine, and Compose. Keep the backend
running; its dashboard window can be closed. Installing only the `docker` command does not supply
an engine. See Docker's [Engine installation](https://docs.docker.com/engine/install/) and
[Desktop installation](https://docs.docker.com/desktop/setup/install/) guides.

OpenTeam uses the active Docker context and checks the engine and Compose rather than a particular
VM manager. It does not install or start a VM backend or switch Docker contexts. Before installing,
confirm that both commands succeed against the engine you intend to use:

```sh
docker info
docker compose version
```

The stack is four long-running containers (PostgreSQL, server, worker, computer) plus a few
one-shot jobs that sync the database schema and fix volume permissions. Public HTTPS mode adds a Caddy
container for certificates. Docker runs the whole server stack, including the agent desktop.

## Install

```sh
curl -fsSL https://openteam.so/install | sh      # macOS and Linux
irm https://openteam.so/install.ps1 | iex        # Windows PowerShell
```

The installer detects the operating system and architecture, downloads the matching native CLI
from the latest GitHub release (the compressed copy when the release has one), verifies it against
`SHA256SUMS`, installs it, and starts the guided setup. It needs Docker and, on macOS and Linux, `curl`; no Node.js or Bun. Set
`OPENTEAM_BIN_DIR` to choose another CLI location, or `OPENTEAM_VERSION` to install a specific
release.

| Platform | CLI installed to | PATH |
| --- | --- | --- |
| macOS, Linux | `~/.local/bin/openteam` | Add the directory yourself if your shell does not already include it |
| Windows | `%LOCALAPPDATA%\OpenTeam\bin\openteam.exe` | Added to your user PATH automatically |

The examples below use `openteam ...`. Re-running the install command later replaces the CLI
binary with the latest release and then runs `openteam install`, which leaves an existing
installation alone and just starts it.

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

## Connection defaults

Normal setup is a single interactive session with three sections: Account, Inference, and Review.
Left and Right move between sections, Up and Down move the highlight, Enter picks an option or
edits a field, and Esc cancels without changes. You can also type to replace a highlighted field,
and finishing a required field advances automatically. The Review section summarizes the configuration,
lists anything still missing, and applies it. Fresh installs automatically use a detected Tailscale,
WireGuard, or LAN address for private-network access. If none can be detected, setup asks only for
the private address. Use `openteam setup --advanced` to change the connection mode.

| Mode | Use when | Ports opened | You must |
| --- | --- | --- | --- |
| **Public HTTPS** | The server has a public IP and you own a domain | 80 and 443 on all interfaces. API and screen viewers stay on loopback. | Point an A or AAAA record at the host and allow inbound TCP 80 and 443. |
| **Existing HTTPS proxy** | You already run nginx, Caddy, Traefik, or a load balancer | Nothing. API binds to `127.0.0.1`. | Proxy to `http://127.0.0.1:8787` and forward WebSocket upgrades. |
| **Public HTTP** | Quick test on a bare IP, no TLS | API port on all interfaces. Viewers stay on loopback. | Open the API port. Tick the cleartext acknowledgement. |
| **Private network** (default) | The host is only reachable over a LAN or VPN such as Tailscale | API port and `6200-6299` on all interfaces | Nothing if a private IP is detected. |
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
- **Private network.** Setup prefers a Tailscale address, then a LAN address. The app supplies a
  generated credential for each live screen. Keep the viewer ports on a trusted LAN or VPN.

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
```

Every credential change signs out all desktop and iPhone sessions.

## Connect a model provider

The Inference step picks the provider that all bots use and automatically chooses its recommended model.
Choose **Skip for now** to finish setup without provider validation or sign-in. OpenTeam remains
available for account and server management, but bots cannot run turns until inference is connected.
Advanced setup can change the model during installation. You can also change it at any
time from the desktop app (**Settings → Server**) or the CLI, without restarting anything.

If the Codex CLI or Claude Code is already signed in on this machine, setup detects it (in
`~/.codex/auth.json`, `~/.claude/.credentials.json`, or the macOS Keychain), preselects that
provider with a **detected** tag, and reuses the sign-in so no browser login is needed. Set
`CODEX_HOME` or `CLAUDE_CONFIG_DIR` if those tools keep their files elsewhere.

| Provider | Sign in with | Default model |
| --- | --- | --- |
| `openai-codex` (default) | ChatGPT Plus or Pro account (OAuth) | `gpt-5.6-sol` |
| `anthropic` | Claude Pro or Max account (OAuth), or an Anthropic API key | `claude-sonnet-5` |
| `openai` | OpenAI API key | `gpt-5.6-sol` |
| Custom | Any OpenAI-, Anthropic-, or Google-compatible endpoint with an API key | Your choice |

Fresh installations start with `medium` thinking. Reconfiguring an existing provider preserves
its saved model and reasoning level unless you change them.

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

**Desktop.** Download it from [openteam.so/download](https://openteam.so/download), which offers
the builds present in the latest [GitHub release](https://github.com/raghavpillai/openteam/releases):
macOS (Apple silicon and Intel), Windows, and Linux AppImage. A platform's installer is published
only when the release workflow has that platform's signing credentials, so check the download page
for what the current release includes. On first launch enter the server URL that setup printed,
then sign in with the owner account. Server-side turns and schedules continue when a client
closes. Keep the OpenTeam desktop app running when work needs its approval bridge: launching
delegated tasks, including computer-use workers, or accessing the physical host. Docker Desktop
provides the container runtime; the OpenTeam desktop app provides this separate bridge.

Each bot has its own screen and browser profile inside the shared Linux computer, so different
bots can work concurrently. Multiple viewers can watch the same screen. Use takeover or pause
before typing on a screen an agent is using; this interrupts active agent input and rejects
queued input from before the control change. Return control when the manual step is finished.

**iPhone.** The app in `apps/mobile` is built with Expo. App Store and TestFlight distribution is
not set up yet, so build it yourself with `bun --filter @openteam/mobile ios`. In the app, open
**Settings → Advanced** and enter the server URL. The phone must be able to reach the server over
HTTPS or a private network.

## Manage the stack

| Command | What it does |
| --- | --- |
| `openteam status` | Version, install directory, access mode, public URL, container list, health. Exits non-zero when unhealthy. |
| `openteam doctor` | Host, Docker, port, permission, readiness, and a live API request to the selected model. Exits `2` if any check fails. |
| `openteam start` | Start the stack and wait for health. |
| `openteam stop` | Stop the containers. Data is kept. |
| `openteam logs [server] [--follow] [--tail 200]` | Show or stream container logs. |
| `openteam setup [--advanced]` | Re-run optional inference setup. Add `--advanced` to change connection or server settings. Keeps the account and active sessions. |
| `openteam provider ...` / `openteam model ...` | Manage providers and the active model. See above. |
| `openteam account update` | Change the owner credentials. |
| `openteam update [--version X]` | Upgrade the stack. See below. |
| `openteam uninstall [--purge]` | Remove the stack. See below. |

`doctor` sends one short request through the computer using the saved provider, model, and
thinking setting. This checks that the provider can actually respond, including for API-key
and subscription sign-ins. The model request has a 30-second timeout and uses normal provider
usage. A failed request is a blocking **AI connection** check; credentials are redacted from
diagnostics. If no provider is connected, the test is explicitly marked as not tested. The
request runs without bot tools or conversation history and does not change your model selection.

The standalone report groups service, AI, storage, and host/setup checks, with recovery commands
for failures. It checks Docker health and recent restart loops, the schema deployment container's
exit status, a database query using the server's credentials, and the computer API from the server.
Worker diagnostics include a fresh event-loop heartbeat, a small job that must be consumed and
acknowledged through the real queue, overdue runnable jobs, and expired leases on running tasks.
The diagnostic job is removed afterward and has a short retention limit. Older worker images
without the diagnostic hook are reported as unverified failures; update them with
`openteam update --force`.

Storage checks create, read, and delete temporary files in each service's writable volumes and
in the computer workspace as the bot's unprivileged UID. They also check service access to existing
agent directories. Doctor reports permission problems without changing permissions. Docker
commands have a 10-second default limit; service probes allow 15 seconds and the model probe
allows 40 seconds. Guided install/setup preflight stays lightweight and skips these live probes.

Doctor always finishes without starting services or launching setup. A stopped stack, incomplete
installation, unfinished owner setup, or failed check exits `2`; warnings alone exit `0`. On a
fresh machine, missing installation is a warning, but host or port failures still exit `2`.
Redirected output and `NO_COLOR` omit colors, and the report wraps to the terminal width.

`openteam setup --advanced` adds the connection mode, API port, time zone (IANA name such as
`America/New_York`), inference model, thinking level, and the number of tasks that can run at once.

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

`openteam update` is also the standalone CLI updater. It downloads the target release's native CLI
beside the installed executable, verifies both checksums and the GitHub Actions Sigstore identity,
and runs the server transaction through that staged CLI. The installed CLI is replaced only after
the new server passes readiness checks; the prior executable is retained as `.previous`. The
Desktop app uses its bundled CLI instead, so Desktop's signed app update replaces that copy.

CLIs released before self-update support cannot bootstrap code they do not contain. Existing early
installations need to re-run the install command once; subsequent releases use `openteam update`
alone.

What an update does:

1. Resolves the target release and, when necessary, verifies and stages its native CLI.
2. Takes a lock so two server transactions cannot overlap.
3. Refuses downgrades and prereleases unless you pass `--allow-downgrade` or `--allow-prerelease`.
   Re-applying the current version needs `--force`.
4. Checks for 4 GB of free disk and that Docker accepts the new Compose file.
5. Downloads and verifies the new release, then pulls its images.
6. Stops the server, worker, and computer briefly and writes a PostgreSQL dump to
   `<install dir>/backups/`.
7. Starts the new release, waits until its health endpoint reports `ready`, and then promotes the
   staged CLI.

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
stop sending messages and let active runs finish first. The names above are the keys in the Compose
file; Docker prefixes the project name, so `docker volume ls` shows them as
`openteam_openteam_postgres`, `openteam_openteam_workspace`, and so on. A dev stack from the repo
uses project `openteam-dev`, so its volumes are `openteam-dev_openteam_*`, and every container
carries a `com.openteam.environment` label of `production` or `development`, so the two never
collide on one machine.

Volumes belong to the Docker engine that created them. Switching Docker contexts or VM backends
does not move the volumes or their data. Back up this recovery set on the old engine and restore
it on the new one before removing the old backend.

**Back up a released install:**

```sh
D=~/.openteam
OUT=./openteam-backup-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT"
docker compose --project-name openteam --project-directory "$D" -f "$D/compose.yaml" \
  exec -T postgres pg_dump -U openteam -d openteam --format=custom > "$OUT/postgres.dump"
for v in computer_home agent_data assets workspace box_store; do
  docker run --rm -v "openteam_openteam_$v:/source:ro" -v "$(cd "$OUT" && pwd):/backup" alpine:3.22 \
    tar -czf "/backup/openteam_$v.tar.gz" -C /source .
done
```

Also copy `~/.openteam/.env`. It holds the database password and signing secrets the restored
data expects. For the dev stack, `sh scripts/backup.sh` in the repo does the same thing; run it
with `PROJECT=openteam` to back up a CLI install from a checkout instead.

**Restore:**

```sh
D=~/.openteam; C="docker compose --project-name openteam --project-directory $D -f $D/compose.yaml"
openteam stop
$C up -d postgres
$C exec -T postgres dropdb -U openteam --force openteam
$C exec -T postgres createdb -U openteam openteam
$C exec -T postgres pg_restore -U openteam -d openteam < "$OUT/postgres.dump"
for v in computer_home agent_data assets workspace box_store; do
  docker run --rm -v "openteam_openteam_$v:/target" -v "$(cd "$OUT" && pwd):/backup:ro" alpine:3.22 \
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
- **Screen viewers require a credential.** The `6200-6299` range serves live bot screens over
  noVNC. The authenticated app supplies a generated per-screen credential in the viewer URL
  fragment. The viewer removes the fragment from the visible URL and keeps the credential in
  tab-scoped session storage for refreshes. Treat viewer links as credentials and keep these
  ports on loopback or a trusted private network.
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

- **Docker CLI works but the daemon is unreachable.** `docker --version` checks only the client.
  Run `docker info`, start the intended Docker backend, and check `docker context show`. On a
  Linux host, start Docker Engine; on macOS or Windows using Docker Desktop, start its backend.
- **Physical-host bridge is offline.** Keep the OpenTeam desktop app running and connected to
  the intended server. Its approval bridge must be reachable from the computer container and
  use the same control token. Delegated task launches, including computer-use workers, need
  this bridge even when the Docker services themselves are healthy.
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
- **`Sigstore verification failed ... root was signed by 0/3 keys`.** The withdrawn 0.1.0 native CLI could
  not verify signatures because of a runtime difference in its bundled JavaScript engine; the
  release itself is fine. Re-run the install command to pick up a fixed CLI. If you must proceed
  with the old binary, `openteam install --allow-unsigned` skips the signature check but still
  verifies the `SHA256SUMS` checksum.
- **`Bind for 127.0.0.1:6200 failed: port is already allocated`, `Another OpenTeam server is
  answering`, or `rejected this installation's control token`.** A different stack holds the
  OpenTeam ports, most often the development Compose stack (`bun run compose:up`, Compose project
  `openteam-dev`) on the same machine. The two cannot share `8787` and `6200-6299`. Stop the other
  stack with `bun run compose:down` (or `docker compose -p openteam-dev down`), then run
  `openteam start`. `openteam doctor` names the container that holds each port.
