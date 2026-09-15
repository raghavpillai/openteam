# OpenTeam CLI

## Status and health

`openteam status` and `openteam health` are aliases. Both show the containers for the selected
installation, Docker health checks, setup job results, and the local server's readiness and release.
Use `--dir <path>` to check another installation. Commands shown in the report keep that directory.

The report distinguishes **RUNNING**, **STARTING**, **STOPPED**, **NEEDS ATTENTION**,
**STATUS UNKNOWN** (a check was blocked), and **NOT INSTALLED**. It shows missing services,
unhealthy or restarting containers, failed replicas, and exit codes. Successful setup jobs are
shown as completed. Containers without a Docker health check are labeled explicitly.

Neither command changes configuration or starts services, and neither sends a model request.
The services' bounded self-tests create and clean up diagnostic queue jobs and temporary workspace files. Exit code `0` means the required services
and server are ready; `2` means they are not ready or could not be checked. Provider setup is shown
separately and does not make healthy containers fail. Use `openteam doctor` for deeper diagnostics.
The existing `status --json-progress` behavior for desktop-managed updates also works with `health`.

```sh
openteam status
openteam health --dir /path/to/installation
bun run test:status
bun run preview:status --list
bun run preview:status --scenario unhealthy --width 40
bun run preview:status --scenario docker-stopped --no-color
bun run preview:status --scenario all --output /tmp/openteam-status-reports
bun run preview:status --gallery /tmp/openteam-status-gallery
```

Status tests cover 41 scenarios through the collector and both CLI entry points, including Docker
and Compose failures, startup, stopped containers, missing services, failed jobs, and API errors.
The CLI subprocess tests use isolated Docker stubs and local HTTP fixtures; they verify exit codes,
alias parity, project selection, and that installation files stay unchanged. Subprocess and PTY
tests run on macOS/Linux; the PTY tests require Python 3. Renderer checks cover six terminal widths,
ANSI/no-color output, and saved snapshots. Preview scenarios use the same fixtures and renderer.
Update intentional snapshot changes with `bun test ./test/status.test.ts --update-snapshots`.

### What healthy means

The worker now has a Docker health check in both production and development Compose files.
It requires a fresh event-loop heartbeat, registered application queue consumers, working
application/queue database access, an authenticated computer connection, accessible storage,
and a diagnostic job consumed and acknowledged by that exact worker instance. Concurrent
Docker and doctor probes share one check so they cannot cause false failures in each other.

Server readiness verifies live database and queue queries and the authenticated computer API.
Computer readiness launches a process as the agent user and verifies workspace file creation,
readback, and deletion. Status displays separate database, queue database, and computer results.
Doctor additionally tests model access, storage round trips, job backlog, leases, and configuration.

These checks cover core service readiness. They do not guarantee every plugin, external provider,
browser session, or user task will succeed. Doctor sends a small model request; health does not.
Existing containers need images and Compose configuration from this change to show the new check.
See [Health checks and chaos tests](../../docs/health-checks.md) for coverage and repeatable testing.

## Testing doctor errors and terminal output

Run the doctor regression suite from this directory:

```sh
bun run test:doctor
```

The suite covers missing Docker, Compose fallback and unsupported versions, stopped engines,
socket permissions, remote DNS/SSH/TLS/API errors, broken configuration, service and migration
failures, storage problems, health responses, and provider failures. Process tests run the real
CLI against isolated fake Docker executables and local HTTP fixtures. They assert exit codes,
recommended actions, and that installation files and service state are unchanged.

UI tests render every scenario at 24, 40, 60, 76, 90, and 110 columns with and without ANSI colors.
They check wrapping, Unicode paths, secret redaction, skipped-check summaries, and recovery
ordering. Checked-in snapshots cover representative full and compact reports. On macOS/Linux
with Python 3, additional tests use a real pseudo-terminal to check colors, progress-line cleanup,
`NO_COLOR`, and `TERM=dumb` behavior. Windows recovery copy is covered by the portable renderer
tests; the POSIX executable-permission and pseudo-terminal tests are skipped on Windows.

Preview the same fixtures in your terminal without running any diagnostic probes:

```sh
bun run preview:doctor --list
bun run preview:doctor --scenario docker-missing
bun run preview:doctor --scenario docker-stopped --width 40 --compact
bun run preview:doctor --scenario provider-quota --no-color
bun run preview:doctor --scenario all --output /tmp/openteam-doctor-reports
bun run preview:doctor --gallery /tmp/openteam-doctor-gallery
```

Open the generated gallery's `index.html` to switch between scenarios, widths, full/compact
reports, and light/dark palettes. It displays the renderer's actual ANSI text; it has no live
shell connection. Review deliberate layout changes before updating snapshots with
`bun test ./test/doctor-matrix-ui.test.ts --update-snapshots`.

Install and manage the self-hosted OpenTeam server stack. It requires a running Docker Engine for
Linux containers, the Docker CLI, and Compose 2.20 or newer. The supported installer downloads a
native CLI, so Node.js and Bun are not required.

Linux can run Docker Engine and Compose directly. On macOS and Windows, Docker Desktop supplies
the Linux VM and Docker tools; its backend must stay running. The CLI checks the engine and
Compose, without requiring Docker Desktop specifically. It uses your active Docker context and
does not install or start a VM backend. Verify it with `docker info` and `docker compose version`.

```sh
curl -fsSL https://openteam.so/install | sh
```

## Commands

```text
openteam install
openteam setup
openteam doctor
openteam status
openteam update
openteam stop
openteam start
openteam logs
openteam provider <list|login|logout|add|remove>
openteam model [list|use]
openteam account update
openteam uninstall
```

Run `openteam <command> --help` or `openteam help <command>` for command-specific usage and
options. Provider and model subcommands have their own help pages as well.

`start` and setup check for port conflicts before starting containers, including Tailscale Serve
listeners that can block Docker's host port forwarding even when Docker reports a running server.
Loopback servers behind Tailscale Serve are allowed. Conflicts report the affected port and how to
inspect or change the listener; the CLI does not change Tailscale rules automatically. While waiting
for readiness, the CLI prints the health URL, current failure, and elapsed time. If the server is
ready inside Docker but remains unreachable from the host, startup reports a forwarding error
instead of waiting the full three minutes.
On success, `start` also prints the configured network address when it differs from the local
health-check address, so you can connect from another device using your Tailscale, LAN, or HTTPS URL.
Storage initialization and database migrations run as one-time jobs. Docker displays `Exited` after
they finish; exit code `0` means they completed successfully. The server, worker, database, and
computer services keep running.
Repeating `start` still runs preflight. If all required services and the expected server release are
ready, it prints `OpenTeam is already running` with the connection addresses and leaves the services
and completed setup jobs alone. Otherwise it reports whether OpenTeam is stopped, partially running,
or not ready before starting or checking the services.
`start` requires completed account setup and directs unfinished installations to `openteam setup`.

Connecting an AI provider can be skipped during setup; services can still run, but startup explicitly
reports that AI tasks need a provider connection. `install --no-setup` remains an explicit automation
option for starting the core services before account setup.

Human-facing commands use a consistent terminal layout: grouped help, a service dashboard for
`status`, connected-account and model catalogs, and clear confirmations for lifecycle and account
changes. Model listings highlight the saved selection and thinking level and retain complete model
identifiers. `status` exits `2` when required services or initialization jobs are not ready, including
a missing worker even if the API responds. Use `doctor` for deeper connection and storage checks.
Output wraps to the terminal width and respects `NO_COLOR` and `TERM=dumb`. Redirected output has
no color escapes; `--version`, update JSON progress, and raw Docker log streams keep their existing
formats. Human update progress shows each phase as it happens.

`openteam install` enters staged setup in the same command. The standalone `openteam setup` command
reconfigures an existing installation without changing its owner or signing out active sessions.
Fresh installs automatically use a detected Tailscale, WireGuard, or LAN address for private-network
access, create the OpenTeam username and password, and optionally connect an inference provider. A
recommended model is selected automatically, or inference can be skipped and configured later. The guided choices cover
ChatGPT Plus/Pro OAuth, Claude Pro/Max OAuth, OpenAI and Anthropic API keys, and compatible custom
endpoints. `openteam setup --advanced` exposes other connection modes. Public HTTPS uses a bundled Caddy service:
point a domain's A/AAAA record at the VM and open inbound TCP ports 80 and 443, and Caddy obtains and
renews the certificate automatically. No certificate needs to exist on the VM beforehand.
Normal setup runs as one interactive session with Account, Inference, and Review sections. Left and Right
move between sections, Up and Down move the highlight within a section, Enter picks the highlighted
option or edits the highlighted field, typing replaces a highlighted field, and finishing required fields
advances automatically. Esc cancels without changes. The Review section lists anything
still missing and applies the configuration. Terminals without cursor support (`TERM=dumb`) fall back to
typed prompts.

Public HTTP accepts an IP address or hostname, but it sends passwords and bearer sessions without
encryption and is rejected by the iOS app. Setup therefore requires an explicit warning
acknowledgement. Internet-facing modes keep the raw screen-viewer range on loopback; private mode
may expose it only within the trusted LAN or VPN.

Passwords are hidden, confirmed, and sent to the server over stdin; they are never stored in `.env`.
Use `openteam account update` to interactively replace both credentials. Pass `--username <name>`
for a username-only update, `--password` for a hidden password-only prompt, or combine the flags.
Every credential update revokes all current sessions. Use `openteam setup --advanced` to override
the connection mode, hostname, local API port, time zone, model, thinking level, or number of tasks that can run at once.
The time zone, private-network address, free API port, current inference settings, and initial task limit are
detected when possible. Setup also detects compatible Codex CLI and Claude Code sign-ins and reuses
them without opening another browser login when the installed computer image supports importing
sign-ins. Older images use a fresh provider sign-in and explain this before setup is applied. For
ChatGPT sign-in over SSH, choose Device code login when prompted.
Setup and provider login verify that authentication was saved before reporting a connection.
If input closes before sign-in finishes, retry the login in an interactive terminal. Setup also
checks that the running server can use the sign-in before declaring authenticated setup ready.
The setup header shows the CLI version; the installed server release is labeled separately.

Run `openteam model` to open the interactive model editor for an installed, running server. Left/Right
switch between **Inference** and **Transcription**; Up/Down moves the highlight and Enter selects or
edits a field. Each tab has its own **Save** action. Esc goes back and asks before discarding unsaved
edits. Add `--dir /path/to/installation` to select another installation.

Inference starts with a provider, followed by its searchable chat model list and a thinking level.
Selecting a disconnected provider opens sign-in and returns to the editor. Transcription offers
OpenAI or an OpenAI-compatible audio endpoint, model browsing or manual model ID entry, language,
and a masked API key. Browsing does not save or enable transcription. Model discovery filters out
known chat, embedding, image, and speech-generation models. Saved keys stay on the server, blank key edits
keep them, and changing endpoints never transfers a stored key. Use **Remove saved key** to clear it.
**Test saved connection** checks the provider and model catalog; send a voice note to verify actual
audio transcription. Transcription needs its own API credentials, separate from ChatGPT sign-in.

`openteam model list` and `openteam model use <provider> <model>` remain available for scripts.
To inspect UI states without changing server settings, run `bun run preview:model --gallery
../../output/model-ui` from `apps/cli`, or run `bun run test:model` for keyboard, HTTP, and terminal tests.

Use `openteam provider login [provider]` to configure OAuth/subscription or API-key authentication without repeating server setup. `provider list` shows Anthropic, the two OpenAI authentication modes, and custom endpoints you have added. Anthropic offers Claude Pro/Max OAuth or an API key; OpenAI API access uses `openai`, while ChatGPT/Codex OAuth uses `openai-codex` and its separate subscription catalog.

`model list` lists chat models reported by connected providers, grouped by provider. Use `model list
anthropic` to narrow it. Missing credentials, rejected requests, or unavailable discovery produce
an actionable message and no selectable models for that provider. The bundled Pi catalog supplies
model metadata; it does not grant access or supply a fallback list. Selection checks discovery again.

Custom endpoints can use Pi's `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai` adapters. For example:

```sh
openteam provider add local --name "Local models" \
  --base-url http://host.docker.internal:11434/v1 \
  --api openai-completions --no-auth
openteam model list local
openteam model
```

Use an endpoint reachable from the **computer container**. Its `localhost` is the container itself.
Omit `--no-auth` for authenticated endpoints: `provider add` prompts for the API key or password
and passes it over stdin; credentials are not written to `.env` or command arguments. No initial
`--model` is needed. That optional flag supplies model metadata, but does not bypass discovery or
access checks. Existing provider IDs cannot be replaced with `provider add`; remove and re-add them
after switching away from the provider.

OpenAI-compatible discovery uses `<base-url>/models`; a host-only base URL gains `/v1`.
Anthropic uses `/v1/models`, and Google-compatible endpoints use `/v1beta/models` when given that
base URL. Discovery support is required for selectable chat models. Provider catalogs do not always
declare model types: capability metadata takes priority, followed by known model families. Opaque
IDs on a custom chat endpoint are treated as chat models. A listed model is not a guarantee of
quota, billing, or tool support; `openteam doctor` tests a real inference request.
See [provider discovery details](../../docs/model-providers.md).

`openteam logs`
shows the most recent 200 lines; add `--follow`, `--tail <lines>`, or `--service <name>` to narrow a
diagnostic session. Existing-proxy mode keeps OpenTeam on loopback and prints the HTTP upstream; the
external proxy must forward HTTPS and WebSocket upgrades to it and replace inbound
`X-Forwarded-*` headers with values derived from its own connection.

Install and update verify release files against their GitHub Actions Sigstore identity and
checksums. A standalone update also verifies and stages the target CLI executable before touching
the server, then safely promotes it only after the updated server reports healthy. Updates are
serialized by an installation lock, reject downgrades and prereleases by
default, validate Docker and free disk, create a private PostgreSQL backup, pull immutable image
digests, and require the requested release to report ready. A failed post-migration startup restores
the retained database backup before restarting the prior release. The latest job state is stored in
`update-state.json`; backups are retained under `backups/` for operator recovery.

The Electron client can run this command locally or over non-interactive SSH. Remote use requires a
working SSH agent, an existing host-key entry, and `openteam` on the remote command path. Password and
host-key prompts are intentionally rejected.

`openteam update` remains the only update command an operator needs. When a newer standalone CLI is
part of the target release, the current CLI downloads and verifies it, then hands the transaction
to that staged executable. The worker follows a replayable high-level progress journal and performs
the server-stack restart only after release verification, image download, and backup finish. It
promotes the staged CLI beside a retained `.previous` copy only after server readiness passes. The
Desktop app instead uses its own bundled CLI, which is replaced by Desktop's signed app update.
Closing the terminal, SSH session, or Electron desktop app does not stop the worker; running the
same update command again
reattaches to the active job. Detailed worker output is retained in `update.log`, and structured
events are retained in `update-events.jsonl` beside `update-state.json`.

An installation whose CLI predates self-update support must re-run the installer once. After that
bootstrap, normal releases require only `openteam update`.

`uninstall` removes the containers but preserves the installation configuration and Docker volumes.
Use `openteam uninstall --purge` to permanently delete the installation data.
