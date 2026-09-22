# Contributor workflow

Follow [development from source](../development/from-source.md) to install dependencies, configure credentials, and start the stack. This reference covers repository structure, checks, and release work.

## Development stack

The root [`docker-compose.yml`](../../docker-compose.yml) defines the development stack. Released
installs use [`deploy/compose.yaml`](../../deploy/compose.yaml).

| Detail | Development | Released install |
| --- | --- | --- |
| Compose project | `openteam-dev` | `openteam` |
| Container names | `openteam-dev-*` | `openteam-*` |
| Volume names | `openteam-dev_openteam_*` | `openteam_openteam_*` |
| `com.openteam.environment` label | `development` | `production` |
| Reported version | Package version with `+dev` | Release version |

The dev API binds to `127.0.0.1:8787`; bot screens use `127.0.0.1:6200-6299`. These ports must
be free, even though the dev and released stacks have separate project names and volumes.
Each live screen uses a generated VNC credential supplied by the authenticated app. Keep
viewer ports on loopback or a trusted private network. Provider credentials live in the
computer volume, never `.env`.

`bun run desktop:tailscale` serves the UI to other devices on your tailnet. See the
[mobile guide](../../apps/ios/README.md) to build the phone app and configure a reachable server URL.

## Repository map

OpenTeam is a Bun and Turborepo TypeScript monorepo.

| Directory | Purpose |
| --- | --- |
| `apps/server` | HTTP and event-stream API |
| `apps/worker` | Durable job runner and bot turns |
| `apps/computer` | Pi runtime, Linux desktop, tools, and MCP execution |
| `apps/desktop` | Electron desktop app |
| `apps/ios` | SwiftUI iOS app |
| `apps/cli` | Installer and server management commands |
| `apps/landing` | Public website and download page |
| `packages/contracts` | Shared API types and schemas |
| `packages/db` | Prisma client, schema, and raw SQL objects |
| `packages/messaging` | Server-side messaging logic |
| `packages/client-core`, `packages/product-core`, `packages/design-tokens` | Shared client behavior, product logic, and design assets |
| `packages/plugin-sdk`, `packages/plugins` | Plugin types, helpers, and bundled packages |
| `packages/shell-jobs` | Shell job support |

Client import boundaries are enforced by `bun run check:architecture`. See
[architecture](../overview/architecture.md) for how the services work together and
[plugin development](plugin-development.md) for adding integrations.

## Checks and common commands

```sh
bun run check                         # Typecheck, tests, build, desktop performance budgets
bun run check:architecture            # Import boundaries, enum parity, mobile bundle, duplication
bun test                              # Run tests directly
bun run db:generate                   # Regenerate the Prisma client
bun run db:deploy                     # Sync schema and raw SQL to DATABASE_URL
bun --filter @openteam/desktop package # Build a desktop installer
bash scripts/compose.sh logs -f server worker computer
sh scripts/backup.sh                  # Dump Postgres and archive the data volumes
```

The worker lifecycle integration test needs a local PostgreSQL database and uses a fake
computer stream. With PostgreSQL running and `createdb` available:

```sh
createdb openteam_test
DATABASE_URL=postgresql://localhost/openteam_test bun run db:deploy
OPENTEAM_TEST_DATABASE_URL=postgresql://localhost/openteam_test \
  bun test apps/worker/test/lifecycle.integration.test.ts
```

For more validation guidance, see [health checks](../reference/health-checks.md),
[performance checks](../../scripts/performance/README.md).

## Releases

Releases are built from `v*` tags. The [release guide](../../.github/RELEASING.md) covers versioning,
signing, CI, desktop installers, and iPhone distribution.
