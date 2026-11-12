# OpenTeam CLI

`openteam` installs and manages a self-hosted OpenTeam server. It sets up the server's connection and
your account, starts and stops the Docker Compose stack, checks its health, manages models and iPhone
push credentials, and installs updates. It's a native executable, so you don't need Node.js or Bun.

The server needs a running Docker engine for Linux containers, the Docker CLI, and Compose 2.20 or
newer. On macOS and Windows, Docker Desktop provides them and must stay running. The CLI uses your
active Docker context; check it with `docker info` and `docker compose version`.

```sh
curl -fsSL https://openteam.so/install | sh      # macOS or Linux
irm https://openteam.so/install.ps1 | iex       # Windows PowerShell
```

The installer downloads and verifies the CLI, checks Docker, and starts guided setup after a
five-second countdown. Press Enter to start now, or Esc, q, or Ctrl+C to cancel and continue later
with `openteam setup`. If Docker is missing, stopped, or too old, setup explains how to fix it and
stops without creating server configuration or starting containers. On macOS, it starts an installed
Docker Desktop and waits up to two minutes for it. See [Installation](../../docs/getting-started/installation.md)
for requirements and where the CLI is installed.

## Commands

```text
openteam install                    Install OpenTeam and run guided setup
openteam setup                      Set up or change the connection and account
openteam status                     Show container health and server readiness
openteam health                     Alias for status
openteam doctor                     Check for installation problems
openteam start                      Start OpenTeam after account setup
openteam stop                       Stop OpenTeam
openteam logs [service]             View troubleshooting logs
openteam update                     Install the latest OpenTeam release
openteam tailscale <enable|status|disable>
openteam notifications <configure|status>
openteam provider <list|login|logout|add|remove>
openteam model [list|use]
openteam account update
openteam uninstall                  Remove OpenTeam services and CLI
```

Run `openteam <command> --help` or `openteam help <command>` for options; subcommands have their own
help pages. Most commands accept `--dir <path>` to manage an installation in another folder. Output
wraps to the terminal width and respects `NO_COLOR` and `TERM=dumb`.

## Everyday use

`openteam start` needs finished account setup; otherwise it sends you to `openteam setup`. It checks
for port conflicts first, including Tailscale Serve listeners that can block Docker's port forwarding.
While it waits for the server (up to three minutes), it prints the health URL, the current failure,
and the elapsed time. On success, it prints the address to use from other devices. If everything is
already healthy, it prints `OpenTeam is already running` and leaves the services alone. If no model
is connected, it says so: the services run, but AI tasks need a connected model.

Storage setup and database migrations run as one-time jobs. Docker shows them as `Exited` when they
finish; exit code `0` means success.

`openteam stop` stops the services and keeps the containers and data. `openteam logs` shows the last
200 lines; add a service name (or `--service <name>`), `--tail <lines>`, or `--follow`.

## Setup and connection modes

`openteam install` runs guided setup in the same command. Run `openteam setup` again whenever you want
to change the connection; it keeps your account and doesn't sign anyone out. Setup asks everything
before it downloads the server images, then starts the server and points you to the desktop and
iPhone apps.

Setup doesn't connect a model. Connect one in the OpenTeam app under **Settings → Model**. On a server
without the apps, use `openteam model` and `openteam provider`.

Setup is one screen with **Connection**, **Account**, and **Review** sections. Left and Right move
between sections, Up and Down move within one, and Enter picks an option or edits a field. Typing
replaces a highlighted field. Esc cancels without changes. **Review** lists anything still missing and
applies the configuration. If a port is busy when the server starts, setup returns to **Connection**
with your answers kept and the API port editable. Terminals without cursor support (`TERM=dumb`) get
typed prompts instead.

| Connection | Use it for |
| --- | --- |
| **Private network** | A Tailscale, WireGuard, or LAN address only your devices can reach. Traffic isn't encrypted, so use it only on a network you trust. |
| **This machine only** | This computer, local development, or an SSH tunnel. |
| **Public domain with automatic HTTPS** | Access from anywhere. A bundled Caddy service gets and renews the certificate: point the domain's A/AAAA records at this server and open inbound TCP ports 80 and 443. |
| **Use my existing HTTPS setup** | An existing nginx, Caddy, Traefik, or cloud proxy. OpenTeam listens on loopback; point the proxy at the local address shown in **Review**, forward HTTPS and WebSocket upgrades, and have it replace inbound `X-Forwarded-*` headers. |
| **Public address without HTTPS** | Temporary testing only. Passwords and sessions travel unencrypted, so setup asks you to confirm the risk. The iPhone app connects over HTTP but shows a warning. |
| **Tailscale HTTPS** | A private HTTPS address from Tailscale Serve on this server. See [Tailscale HTTPS](#tailscale-https). |

On a new install, setup preselects **Tailscale HTTPS** when this host can serve it, and otherwise
**Private network** with a detected address. Running setup again keeps your current choice. Bot screen
viewers are reachable from your LAN or VPN only in **Private network** mode; the other modes keep them
on this machine.

`openteam setup --advanced` also shows the API port and **Tasks at once** (how many tasks can run at
the same time). Every connection mode is available without it.

Plugin sign-in follows the server's public URL. Over HTTPS, providers redirect back to the server;
over HTTP, you paste the redirect URL back, for providers that allow it. See
[Google setup](../../docs/integrations/google.md) for how this affects Google.

### Tailscale HTTPS

```sh
openteam tailscale enable [--https-port 14443]
openteam tailscale status
openteam tailscale disable
```

Keep Tailscale running and signed in, with MagicDNS and HTTPS certificates turned on. `enable` adds a
Tailscale Serve route to OpenTeam (or reuses a matching private route), restarts the stack, and
verifies the HTTPS address. If that fails, it restores the previous configuration instead of falling
back to HTTP. It never replaces another application's route or turns on Funnel. `disable` switches to
local-only access and removes only routes OpenTeam created. All three accept `--dir` and `--json`;
`status` exits `2` if configured HTTPS needs attention. Reconnect the apps after the address changes.

On desktop, **Settings → Server → Remote access** has the same controls for a server on that Mac and
instructions for a remote one.

### Change your username or password

`openteam account update` prompts for a new username and password. Use `--username <name>` to change
only the username, `--password` to change only the password, or both. Every change signs out all
apps. Passwords are typed hidden, confirmed, and sent to the server over stdin; they're never stored
in `.env`.

## Status and health

`openteam status` (or `openteam health`) shows the containers, Docker health checks, setup jobs, and
the server's readiness and release. It reports **RUNNING**, **STARTING**, **STOPPED**,
**NEEDS ATTENTION**, **STATUS UNKNOWN** (a check was blocked), or **NOT INSTALLED**, and lists missing
services, unhealthy or restarting containers, and exit codes. It doesn't change configuration, start
services, or send a model request. Exit code `0` means the services and server are ready; `2` means
they aren't or couldn't be checked. A missing model connection is shown separately and doesn't fail
the check.

Ready means the core services work: database and queue queries, the worker processing a test job,
and the bot computer creating and deleting a workspace file. It doesn't guarantee that every plugin,
provider, or browser session works.

`openteam doctor` goes further. It checks prerequisites, configuration, storage, the job backlog, and
iPhone push setup (registrations, APNs credentials, and recent delivery errors), and sends one short
request to your saved model. Missing APNs credentials only warn until an iPhone needs push delivery.
Failed checks exit `2`; warnings alone exit `0`. Doctor doesn't start services or change anything, and
you can run it before installing to check prerequisites.

## Models and providers

`openteam model` opens an interactive editor for a running server. Left and Right switch between
**Inference** and **Transcription**. Each tab has its own save action, and Esc asks before discarding
unsaved edits.

**Inference** picks a provider, a model from its searchable list, and a thinking level. Choosing a
provider that isn't connected opens its sign-in screen; **Back to providers** returns to the list.
Browser sign-in offers **Open sign-in page**, **Copy sign-in link**, and **Paste code or redirect
URL**, and Esc or Ctrl+C cancels it. Codes and keys are masked. The model changes only when you save.

| Provider ID | Shown as | Connect with |
| --- | --- | --- |
| `openai-codex` | ChatGPT | ChatGPT plan sign-in |
| `claude-code` | Claude | Claude plan sign-in |
| `openai` | OpenAI | API key |
| `anthropic` | Anthropic | API key |
| `openrouter` | OpenRouter | API key |

For a plan sign-in, **Use Codex login** and **Use Claude Code login** import a sign-in already saved on
this machine. Codex reads `~/.codex/auth.json` (or `$CODEX_HOME`). Claude Code reads
`~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`) or the macOS Keychain. Credentials go to the
server over stdin, never in command arguments.

For scripts, `openteam provider login [provider]` signs in or adds an API key, `provider logout`
removes a credential, and `provider list` shows providers, model counts, and sign-in status.
`openteam model list [provider]` lists the chat models your connected providers report, and
`openteam model use <provider> <model> [--thinking <level>]` sets the model for the whole server
(levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).

**Transcription** sets up voice notes: **OpenAI**, **Deepgram**, or **Custom / OpenAI-compatible**
(your own base URL), plus a model (browse or enter an ID), language, and API key. Transcription needs
its own API key, separate from ChatGPT sign-in. Saved keys stay on the server and show only their last
four characters; leave the field blank to keep one. To remove a key, choose **Delete key**, then
**Save transcription**. Changing the endpoint needs a new key or deleting the saved one. **Test saved
connection** checks the provider and its model list; send a voice note to confirm transcription works.

### Custom endpoints

```sh
openteam provider add local --name "Local models" \
  --base-url http://host.docker.internal:11434/v1 \
  --api openai-completions --no-auth
openteam model list local
```

`--api` is `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai`.
The URL must be reachable from the **computer container**, where `localhost` is the container itself.
Without `--no-auth`, `provider add` prompts for the key and passes it over stdin. Models are
discovered from `<base-url>/models` (a host-only URL gets `/v1`), so give the API base URL, not a
request endpoint. A listed model isn't a guarantee of quota or tool support; `openteam doctor` sends a
real request. To change a custom provider, switch to another one, then remove it and add it again.
See [Model providers](../../docs/configuration/models.md).

## iPhone push notifications

The iPhone app needs Apple Push Notification service (APNs) credentials on the server:

```sh
openteam notifications configure --config ./apns.json
openteam notifications status
openteam doctor
```

`apns.json` holds `keyId`, `teamId`, `topic` (`dev.openbot.mobile` for the distributed app), and
`privateKeyFile`, the path to your Apple `.p8` key relative to the JSON file. You can pass
`--key-file`, `--key-id`, `--team-id`, and `--topic` instead. The server must be running, and workers
use the new credentials from their next push, with no restart. The key is stored encrypted with the
installation control token, so back up the database and `.env` together and keep your `.p8` file in
case you need to import it again. Saved credentials take precedence over `OPENTEAM_APNS_*`
environment variables. None of these checks send a test alert; confirm delivery on a real iPhone. See
[Mobile notifications](../../docs/configuration/mobile-notifications.md).

## Updates

`openteam update` updates the CLI and server in one job. It verifies the release files against their
GitHub Actions Sigstore identity and checksums, checks Docker and that at least 4 GiB of disk is free,
pulls the new images, stops the services, saves a PostgreSQL backup under `backups/`, then starts the
new release and waits until it reports ready. If the update fails, it restores the previous
configuration, restores the database backup if the new release had already started, and restarts the
previous release.

Downgrades and prereleases are refused unless you pass `--allow-downgrade` or `--allow-prerelease`.
Other options are `--version <version>`, `--force` (reapply the installed release), and `--when-idle`
(refuse, changing nothing, while any bot is working).

The update runs as a background job, so closing the terminal or SSH session doesn't stop it; run
`openteam update` again to reconnect. Its state, events, and full output are in `update-state.json`,
`update-events.jsonl`, and `update.log` in the installation folder. A standalone CLI downloads and
verifies the new CLI first and replaces itself only after the new server is healthy, keeping the old
executable beside it with a `.previous` suffix. The desktop app uses its own bundled CLI, which updates
with the app. See [Updates](../../docs/manage/updates.md).

### Disk maintenance

After a successful update, OpenTeam removes older images it pulled for this installation, keeping the
current and previous release. Images that you tagged, that other installations use, or that any
container references are kept. It also keeps only the newest 3 database backups the updater made,
plus the one from this update. A failed update cleans up nothing. Cleanup never touches databases or
Docker volumes, messages, bot memory, workspace files, credentials, or browser sign-ins.

Two limits apply all the time, not only during updates. Docker rotates each container's logs at
10 MiB × 3 files. The bot's browser keeps its HTTP cache near 128 MiB and clears its cache folders
before restarting after a normal exit; cookies, sign-ins, and site data stay.

Set these in the installation's `.env`:

- `OPENTEAM_BACKUP_RETENTION_COUNT`: updater backups to keep (default `3`; `0` keeps them all).
- `OPENTEAM_LOG_MAX_SIZE` and `OPENTEAM_LOG_MAX_FILES`: log rotation (defaults `10m` and `3`). They
  apply when the containers are next recreated, such as by an update.

Older backups are deleted, so to keep one, copy it somewhere else (or into a subfolder of `backups/`)
before the next update, and protect it like the database itself. Don't run `docker system prune` or
volume pruning as routine maintenance.

## Uninstall

`openteam uninstall` removes the containers and the standalone `openteam` executable, but keeps the
installation folder (configuration and backups) and the Docker volumes that hold your data. Run the
installer again to restore the CLI and recreate the containers with the preserved data.
`openteam uninstall --purge` permanently deletes the containers, volumes, configuration, and data, as
well as the CLI. Add `--yes` to skip the confirmation.

## Development and tests

Run these from `apps/cli`:

```sh
bun run test                 # all CLI tests
bun run test:doctor          # doctor checks, recovery steps, and terminal output
bun run test:status          # status/health, start, and their terminal output
bun run test:model           # model editor keyboard, HTTP, and terminal tests
bun run test:install         # installer preflight and setup countdown
bun run test:install:fresh   # real installer in a clean Debian container (needs privileged Docker)
```

Process tests run the real CLI against fake Docker executables and local HTTP fixtures. The
pseudo-terminal tests need macOS or Linux with Python 3 and are skipped on Windows.

Preview terminal output from the test fixtures without touching a server:

```sh
bun run preview:doctor --list
bun run preview:doctor --scenario docker-stopped --width 40 --compact
bun run preview:status --scenario unhealthy --no-color
bun run preview:doctor --gallery /tmp/openteam-doctor-gallery
bun run preview:status --gallery /tmp/openteam-status-gallery
bun run preview:model --gallery /tmp/openteam-model-ui
```

Open a gallery's `index.html` to compare scenarios and widths. After a deliberate layout change, update
snapshots with `bun test ./test/doctor-matrix-ui.test.ts --update-snapshots` (or
`./test/status.test.ts`).

Other harnesses:

- `bun scripts/test-windows-install.ts` tests the Windows installer under Windows PowerShell 5.1 and
  PowerShell 7 (needs Python `pywinpty` and `pyte`; Docker is simulated). Use a disposable Windows
  machine: it temporarily hides any installed Docker CLI.
- `python scripts/render-installer-demo.py` renders the fresh-install recordings as MP4 and GIF (needs
  `pillow`, `pyte`, and `ffmpeg`; pass `--font` outside macOS).
- From the repository root, `bun run test:health:chaos` injects health-check faults.
- From the repository root, `OPENTEAM_TEST_DOCKER_CONTEXT=<throwaway-context> bun apps/cli/scripts/test-disk-maintenance-docker.ts`
  tests image and backup retention against a real Docker daemon. It removes only its own fixtures.
- From the repository root, `OPENTEAM_TEST_CHROMIUM_EXECUTABLE=<chromium> bun apps/computer/scripts/test-browser-cache-maintenance.ts`
  tests browser cache cleanup with a temporary profile.

Reports, recordings, and demo media go to `output/` at the repository root. The `CLI installer`
GitHub Actions workflow runs the installer checks on Linux, macOS, and Windows.
