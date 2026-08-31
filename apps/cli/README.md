# OpenBot CLI

Install and manage the self-hosted OpenBot server stack. Docker with Compose is the only system
prerequisite.

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
openbot account update
openbot password reset
openbot uninstall
```

Run `openbot setup` after installation. The quick setup chooses local or private-network access,
creates the single OpenBot username/password owner, then offers to start OpenAI Codex sign-in.
Passwords are hidden, confirmed, and sent to the server over stdin; they are never stored in `.env`.
Use `openbot account update` to interactively replace both credentials. Pass `--username <name>`
for a username-only update, `--password` for a hidden password-only prompt, or combine the flags.
`openbot password reset` remains a password-only alias. Every credential update revokes all current sessions. Use
`openbot setup --advanced` to override the detected hostname, API port, time zone, model, reasoning
effort, or concurrent bot job limit.

`uninstall` removes the containers but preserves the installation configuration and Docker volumes.
Use `openbot uninstall --purge` to permanently delete the installation data.
