# Development from source

Run OpenTeam from a source checkout to change it or try unreleased code. For everyday use, the [installer](../getting-started/installation.md) is simpler.

## Prerequisites

- Git
- [Bun](https://bun.sh), at the version pinned in the root `package.json`
- Docker Engine with Compose 2.20 or newer
- Bash, to run the commands below from the repository root

The development server uses the same ports as a released installation. If both run on one machine, stop one before starting the other.

## Get the source

```sh
git clone https://github.com/raghavpillai/openteam.git
cd openteam
bun install --frozen-lockfile
bun run db:generate
cp .env.example .env
```

In `.env`, replace `OPENTEAM_CONTROL_TOKEN`, `OPENTEAM_AUTH_SECRET`, and `OPENTEAM_PROXY_SECRET` with different random values. Generate each with `openssl rand -hex 32`. Set `OPENTEAM_TIME_ZONE` to your time zone. Don't commit `.env`.

## Start the server

```sh
bash scripts/compose.sh up --build -d
bash scripts/compose.sh ps
```

Wait until `server`, `worker`, `computer`, and `postgres` are healthy. Setup containers exit with code `0` when they finish; that's expected.

## Create an account and connect a model

```sh
bun run auth:setup
bash scripts/compose.sh exec computer openteam-pi-auth login openai-codex oauth
```

The first command creates your account. The second signs in with ChatGPT. For other providers, see [model providers](../configuration/models.md).

## Open the desktop app

```sh
curl http://127.0.0.1:8787/api/v0/health
bun run desktop
```

Connect to `http://127.0.0.1:8787` and sign in. To build the iPhone app, see the [iPhone app instructions](../../apps/ios/README.md).

## Check your changes

```sh
bun run typecheck
bun run test
bun run build
```

You can also run the checks for just the package you're working on. `bun run check:architecture` checks package boundaries.

The [contributor reference](../reference/development.md) covers the repository layout, database tests, desktop packaging, and releases.
