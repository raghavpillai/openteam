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
Setup chooses bundled public HTTPS, an existing HTTPS reverse proxy/load balancer, acknowledged
public HTTP, private-network, or loopback access; creates the single OpenTeam username/password owner; and
selects and configures a Pi inference provider and provider-qualified model. The guided choices cover
ChatGPT Plus/Pro OAuth, Claude Pro/Max OAuth, OpenAI and Anthropic API keys, and compatible custom
endpoints. Public HTTPS is recommended and uses a bundled Caddy service:
point a domain's A/AAAA record at the VM and open inbound TCP ports 80 and 443, and Caddy obtains and
renews the certificate automatically. No certificate needs to exist on the VM beforehand.
Setup runs as one interactive session with Access, Owner, Runtime, and Launch sections. Left and Right
move between sections, Up and Down move the highlight within a section, Enter picks the highlighted
option or edits the highlighted field, and Esc cancels without changes. The Launch section lists anything
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
the hostname, local API port, time zone, reasoning effort, or concurrent bot job limit. Provider
and model selection are part of both normal and advanced setup.

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

`uninstall` removes the containers but preserves the installation configuration and Docker volumes.
Use `openteam uninstall --purge` to permanently delete the installation data.
