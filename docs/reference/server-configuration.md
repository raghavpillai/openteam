# Server environment variables

Use guided setup for installation settings. Provider, plugin, search, and app settings have their own controls.

## Installation settings

These live in `<install dir>/.env` (default `~/.openteam/.env`) and are read when containers
start. The CLI writes this file. Change values with:

```sh
openteam setup              # connect or change your model provider
openteam setup --advanced   # also API port, time zone, reasoning effort, concurrent bot turns
```

Setup restarts the stack for you and rolls the file back if the new values fail to start.

Guided setup defaults to private-network access. It accepts API ports from 1 to 65535 and concurrency from 1 to 64 (default 8). Each bot still runs one turn at a time. Setup detects the time zone, falling back to UTC. The base-file defaults in the table below can differ from these detected values.

`OPENTEAM_AUTH_MODE=disabled` removes API login entirely; use it only on a trusted, isolated network. Setup derives bind hosts, public hosts, auth URLs, and Compose profiles from the access mode. Change that mode through setup rather than editing its derived values.

The file also holds four generated secrets (`OPENTEAM_POSTGRES_PASSWORD`, `OPENTEAM_CONTROL_TOKEN`,
`OPENTEAM_AUTH_SECRET`, `OPENTEAM_PROXY_SECRET`), the release version, and the image registry
prefix. Leave those alone. The owner password and inference-provider credentials are never stored here.

## Manual settings

For options unavailable in guided setup, edit `.env` in the install directory and run `openteam stop` followed by `openteam start`. The environment table lists these as set "by hand". A value only reaches a container if its Compose configuration passes it through.

`OPENTEAM_SUBAGENT_PER_PARENT_LIMIT` and `OPENTEAM_SUBAGENT_GLOBAL_LIMIT` appear in `.env.example`, but the runtime does not read them.

## Environment variable reference

Common container settings for operators. Defaults here describe the base configuration before
guided setup detects the network and writes installation-specific values. "Set by" says who
normally writes a value; "Restart" says whether a change needs a container restart.

| Variable | Default | Set by | Restart | Meaning |
| --- | --- | --- | --- | --- |
| `OPENTEAM_VERSION` | release | install, update | yes | Release version and image tag. The dev stack reports the package version plus `+dev`. |
| `OPENTEAM_IMAGE_PREFIX` | `ghcr.io/raghavpillai/openteam` | install | yes | Image registry prefix |
| `OPENTEAM_POSTGRES_PASSWORD` | generated | install | yes | Database password |
| `OPENTEAM_CONTROL_TOKEN` | generated | install | yes | Token the server, worker, computer, and CLI use with each other |
| `OPENTEAM_AUTH_SECRET` | generated | install | yes | Signs login sessions |
| `OPENTEAM_PROXY_SECRET` | generated | install | yes | Shared secret a reverse proxy can send in `X-OpenTeam-Proxy` |
| `OPENTEAM_AUTH_MODE` | `required` | setup | yes | `required` or `disabled` |
| `OPENTEAM_ACCESS_MODE` | `local` | setup | yes | `https`, `proxy`, `http`, `private`, `local` |
| `OPENTEAM_PUBLIC_URL` | `http://127.0.0.1:8787` | setup | yes | Client-facing base URL, plugin OAuth redirects, Caddy domain |
| `OPENTEAM_AUTH_URL` | same as public URL | setup | yes | Base URL for the auth library |
| `OPENTEAM_API_PORT` | `8787` | setup | yes | Host port for the API |
| `OPENTEAM_BIND_HOST` | `127.0.0.1` | setup | yes | Interface the API port binds to |
| `OPENTEAM_VIEWER_BIND_HOST` | `127.0.0.1` | setup | yes | Interface for screen viewer ports `6200-6299` |
| `OPENTEAM_PUBLIC_HOST` | `127.0.0.1` | setup | yes | Host the apps use to open screen viewers |
| `COMPOSE_PROFILES` | `direct` | setup | yes | `https` enables Caddy |
| `OPENTEAM_TIME_ZONE` | `UTC` | setup | yes | Installation time zone |
| `OPENTEAM_WORKER_CONCURRENCY` | `8` | setup `--advanced` | yes | Concurrent bot turns |
| `OPENTEAM_MEMORY_DREAMING` | `false` | by hand | yes | Memory synthesis experiment |
| `OPENTEAM_MARKETPLACE_FILE` | empty | by hand | yes | Custom plugin catalog path |
| `OPENTEAM_ENFORCE_AUTOMATION_MINIMUM` | enabled unless `false` | by hand | yes | Enforce the 5-minute routine minimum; set `false` to opt out |
| `EXPO_ACCESS_TOKEN` | empty | by hand | yes | Expo push token |
| `OPENTEAM_BOX_COPY_IN` | `0` | by hand | yes | Copy snapshot store in on boot |
| `OPENTEAM_MCP_OAUTH_CLIENT_ID`, `OPENTEAM_MCP_OAUTH_CLIENT_SECRET` | unset | by hand | yes | Fallback OAuth client for MCP plugins |

Fixed inside the Compose file, not meant to change: `DATABASE_URL`, `OPENTEAM_PORT` (`8787`),
`OPENTEAM_COMPUTER_URL`, `OPENTEAM_COMPUTER_PORT` (`8790`), `OPENTEAM_SERVER_URL`,
`OPENTEAM_WORKSPACE_ROOT` (`/workspace`), `OPENTEAM_AGENT_DATA_ROOT` (`/home/box/agent-data`),
`OPENTEAM_AGENT_DATA_CANONICAL_ROOT` (`/home/box/sand-data`), `OPENTEAM_ASSET_ROOT`
(`/asset-store`), `OPENTEAM_BOX_STORE_ROOT` (`/box-store`), `OPENTEAM_PI_AGENT_DIR`
(`/home/box/.pi/agent`), `OPENTEAM_SCREEN_VIEWER_HOST`, and the agent user ids
`OPENTEAM_AGENT_UID` (`1001`) and `OPENTEAM_AGENT_GID` (`1000`).

The computer service uses `OPENTEAM_HOST_BRIDGE_URL` (default
`http://host.docker.internal:8791`) to reach the OpenTeam desktop app's approval and physical-host
bridge. Delegated task launches, including computer-use workers, require this bridge. For a
desktop app on another host, set a reachable URL in the computer service's environment through
a Compose override and recreate that service. Setting an arbitrary key in the install `.env`
alone does not pass it into the container. The bridge and server must use the same control token.
Docker Desktop supplies the container engine; it does not replace the OpenTeam approval bridge.

Internal tuning knobs, read by the computer service and not meant for operators:
`OPENTEAM_MAX_OPEN_AGENT_STORES` (`32`), `OPENTEAM_AGENT_STORE_IDLE_CLOSE_MS` (`120000`),
`OPENTEAM_NODE_BINARY`, and the debugging switch
`SAND_DISABLE_MEMORY_FREEZE=1`. `BETTER_AUTH_SECRET` is accepted as an alias for
`OPENTEAM_AUTH_SECRET`.

Development-only variables for the desktop app: `OPENTEAM_SERVER_URL`, `OPENTEAM_RENDERER_URL`,
`OPENTEAM_HOST_BRIDGE_PORT` (`8791`), `OPENTEAM_AUTO_REVIEW_MODE` (`off`, `shadow`, `enforce`),
`OPENTEAM_UPDATE_MANIFEST_URL`, `OPENTEAM_DEV_HOST`, and `VITE_OPENTEAM_API_URL`.
