# Development from source

Use a source checkout when you want to change OpenTeam or test unreleased code. For everyday use, start with the [released installer](../getting-started/installation.md).

## Prerequisites

Install Git, the Bun version pinned in the root `package.json`, and Docker Engine with Compose 2.20+. The shell commands below need Bash and run from the repository root.

The development stack uses the same default ports as a released installation, so stop the other stack if both run on the same host.

## Get the source

```sh
git clone https://github.com/raghavpillai/openteam.git
cd openteam
bun install --frozen-lockfile
bun run db:generate
cp .env.example .env
```

Replace `OPENTEAM_CONTROL_TOKEN`, `OPENTEAM_AUTH_SECRET`, and `OPENTEAM_PROXY_SECRET` in `.env` with distinct random values. Generate each separately with `openssl rand -hex 32`. Set `OPENTEAM_TIME_ZONE` to your time zone. Keep `.env` private and uncommitted.

## Start the server

```sh
bash scripts/compose.sh up --build -d
bash scripts/compose.sh ps
```

Wait for the server, worker, computer, and database to be healthy. Setup jobs can exit successfully with code `0`.

## Create an account and connect inference

```sh
bun run auth:setup
bash scripts/compose.sh exec computer openteam-pi-auth login openai-codex oauth
```

The first command creates your owner login. The second starts ChatGPT sign-in inside the computer environment. For other authentication choices, see [model providers](../configuration/models.md).

## Open the desktop app

```sh
curl http://127.0.0.1:8787/api/v0/health
bun run desktop
```

Connect to `http://127.0.0.1:8787` and sign in. Native mobile builds have [separate prerequisites](../../apps/mobile/README.md).

## Make and check changes

Use `bun run typecheck`, `bun run test`, and `bun run build` for workspace checks, or run the relevant package's checks while working. `bun run check:architecture` validates package boundaries.

The [contributor reference](../reference/development.md) has the repository map, database-test setup, and release links.
