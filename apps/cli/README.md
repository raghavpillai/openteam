# OpenBot CLI

Install and manage the self-hosted OpenBot server stack. It requires Docker with Compose 2.20 or
newer, plus either Bun or Node 20.17+ to launch the CLI.

```sh
bunx --bun @openbot/cli install
```

The same package can be run with Node:

```sh
npx @openbot/cli install
```

## Commands

```text
openbot install
openbot setup
openbot doctor
openbot status
openbot update
openbot stop
openbot start
openbot logs
openbot provider login
openbot account update
openbot password reset
openbot uninstall
```

`openbot install` enters staged setup in the same command. The standalone `openbot setup` command
reconfigures an existing installation without changing its owner or signing out active sessions.
Setup chooses bundled public HTTPS, an existing HTTPS reverse proxy/load balancer, acknowledged
public HTTP, private-network, or loopback access; creates the single OpenBot username/password owner; and
offers to start OpenAI Codex sign-in. Public HTTPS is recommended and uses a bundled Caddy service:
point a domain's A/AAAA record at the VM and open inbound TCP ports 80 and 443, and Caddy obtains and
renews the certificate automatically. No certificate needs to exist on the VM beforehand.

Public HTTP accepts an IP address or hostname, but it sends passwords and bearer sessions without
encryption and is rejected by the iOS app. Setup therefore requires an explicit warning
acknowledgement. Internet-facing modes keep the raw screen-viewer range on loopback; private mode
may expose it only within the trusted LAN or VPN.

Passwords are hidden, confirmed, and sent to the server over stdin; they are never stored in `.env`.
Use `openbot account update` to interactively replace both credentials. Pass `--username <name>`
for a username-only update, `--password` for a hidden password-only prompt, or combine the flags.
`openbot password reset` remains a password-only alias. Every credential update revokes all current sessions. Use
`openbot setup --advanced` to override the hostname, local API port, time zone, model, reasoning
effort, or concurrent bot job limit.

Use `openbot provider login` to repair Codex sign-in without repeating server setup. `openbot logs`
shows the most recent 200 lines; add `--follow`, `--tail <lines>`, or `--service <name>` to narrow a
diagnostic session. Existing-proxy mode keeps OpenBot on loopback and prints the HTTP upstream; the
external proxy must forward HTTPS and WebSocket upgrades to it and replace inbound
`X-Forwarded-*` headers with values derived from its own connection.

Install and update verify the release Compose file against its GitHub Actions Sigstore identity and
checksum. Updates are serialized by an installation lock, reject downgrades and prereleases by
default, validate Docker and free disk, create a private PostgreSQL backup, pull immutable image
digests, and require the requested release to report ready. A failed post-migration startup restores
the retained database backup before restarting the prior release. The latest job state is stored in
`update-state.json`; backups are retained under `backups/` for operator recovery.

The Electron client can run this command locally or over non-interactive SSH. Remote use requires a
working SSH agent, an existing host-key entry, and `openbot` on the remote command path. Password and
host-key prompts are intentionally rejected.

`uninstall` removes the containers but preserves the installation configuration and Docker volumes.
Use `openbot uninstall --purge` to permanently delete the installation data.
