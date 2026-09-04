# OpenTeam CLI

Install and manage the self-hosted OpenTeam server stack. It requires Docker with Compose 2.20 or
newer. The supported installer downloads a native CLI, so Node.js and Bun are not required.

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
openteam model <list|use>
openteam account update
openteam uninstall
```

Run `openteam <command> --help` or `openteam help <command>` for command-specific usage and
options. Provider and model subcommands have their own help pages as well.

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
detected when possible.

Use `openteam provider login [provider]` to configure OAuth/subscription or API-key authentication without repeating server setup. `provider list` shows the methods Pi supports, and `model list`/`model use` select a provider-qualified model. Anthropic offers Claude Pro/Max OAuth or an API key; OpenAI API access uses the `openai` provider, while ChatGPT/Codex OAuth uses `openai-codex`.

Custom endpoints can use Pi's `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai` adapters. `provider add` prompts for the API key or password and passes it to the computer service over stdin; credentials are not written to `.env` or command arguments. `openteam logs`
shows the most recent 200 lines; add `--follow`, `--tail <lines>`, or `--service <name>` to narrow a
diagnostic session. Existing-proxy mode keeps OpenTeam on loopback and prints the HTTP upstream; the
external proxy must forward HTTPS and WebSocket upgrades to it and replace inbound
`X-Forwarded-*` headers with values derived from its own connection.

Install and update verify the release Compose file against its GitHub Actions Sigstore identity and
checksum. Updates are serialized by an installation lock, reject downgrades and prereleases by
default, validate Docker and free disk, create a private PostgreSQL backup, pull immutable image
digests, and require the requested release to report ready. A failed post-migration startup restores
the retained database backup before restarting the prior release. The latest job state is stored in
`update-state.json`; backups are retained under `backups/` for operator recovery.

The Electron client can run this command locally or over non-interactive SSH. Remote use requires a
working SSH agent, an existing host-key entry, and `openteam` on the remote command path. Password and
host-key prompts are intentionally rejected.

`openteam update` remains the only update command an operator needs. It hands the transaction to a
detached worker, follows a replayable high-level progress journal, and performs the server-stack
restart only after release verification, image download, and backup finish. Closing the terminal,
SSH session, or Electron desktop app does not stop the worker; running the same update command again
reattaches to the active job. Detailed worker output is retained in `update.log`, and structured
events are retained in `update-events.jsonl` beside `update-state.json`.

`uninstall` removes the containers but preserves the installation configuration and Docker volumes.
Use `openteam uninstall --purge` to permanently delete the installation data.
