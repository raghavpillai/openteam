# Health checks and fault testing

`openteam status` and `openteam health` are the same command. They combine Docker container
health with a fresh server readiness response. `openteam doctor` performs deeper diagnostics
and gives recovery actions. Both use exit code 2 when a required check fails or is blocked.

## Checks

| Surface | What must work |
| --- | --- |
| Worker Docker health | Heartbeat younger than 20 seconds; active consumers for wake, provision, transcript projection and routines; application table and queue metadata queries; authenticated computer API; agent/asset storage access; a job enqueued, consumed and acknowledged by this worker instance |
| Server readiness | Live application database query; live query through the server's queue connection; expected application queues; authenticated computer readiness |
| Computer readiness | Runtime diagnostics; a shell-launched process explicitly running under the intended agent UID/GID; temporary workspace file creation, readback and deletion |
| Doctor | Container state, installation/configuration, server/worker database connections, job backlog, expired run leases, heartbeat, queue round trip, storage read/write/delete, model request, provider/transcription configuration, and applicable public endpoint checks |
| Chaos canary | Owner login, rejection of anonymous API access, client bootstrap/events, bot creation, persisted user message, worker task execution through computer and a local model fixture, and a visible response from a completed run |

Status shows separate Database, Queue database and Computer API rows when the server reports
those fields. A failure includes a relevant log command and a recommendation to run doctor.
Older releases without these fields remain readable; a running container without a Docker
check is still labeled explicitly. The worker check requires the updated image and Compose file.

### Preventing misleading passes

- A TCP listener or a running process alone does not establish readiness.
- Database readiness uses application tables and queue metadata with service credentials.
- Computer requests carry the installation control token and use an authenticated route.
- Each worker owns a distinct diagnostic queue. The response must identify that same worker;
  a healthy replica cannot acknowledge a broken replica's probe.
- Overlapping Docker/doctor probes share one operation. Probe jobs are removed after checking.
- Timed-out dependency queries remain shared until they settle, so repeated health requests
  cannot accumulate a new stuck dependency query each time.
- The workspace probe explicitly drops and verifies its UID/GID inside the child process.
  Testing found that the bundled Bun runtime could ignore the requested spawn UID while
  applying its GID. Trusting the spawn options alone gave a false pass as root. This change
  hardens the diagnostic probe; other agent-tool spawn call sites are not changed or fully
  audited here.
- Errors returned by dependency checks use safe descriptions rather than database credentials.

### Timing and side effects

The production worker check runs every 30 seconds, allows 12 seconds, has a 45-second startup
grace period, and requires three failures before Docker marks it unhealthy. Its heartbeat is
written every five seconds. Queue checks have an eight-second budget plus bounded cleanup.
Server readiness bounds its probes at 2.5 seconds and caches results for two seconds. The
computer's workspace subprocess has a two-second limit and a five-second shared cache.

Health does not change configuration, restart services, or send a model request. Self-tests
create small temporary workspace files and diagnostic jobs, then remove them. Doctor sends a
small model request and performs additional temporary storage checks. Failed probes do not
automatically restart containers.

A healthy result covers these core paths at the time of checking. It does not certify every
plugin, browser session, scheduled routine, media feature or arbitrary user task. Third-party
provider outages remain a doctor failure even when local service readiness is healthy.

## Repeatable chaos run

From the repository root, with dependencies installed and Docker available:

```sh
bun run test:health:chaos
```

The runner builds current worker, server, computer and CLI bundles. It overlays them on runtime
base images; it does not rebuild the entire computer OS image. The defaults are
`ghcr.io/raghavpillai/openteam-computer:0.0.0` and `openteam-migrate:latest`. For a local runtime:

```sh
OPENTEAM_CHAOS_COMPUTER_BASE=openteam-memory-computer:20260913 \
  bun run test:health:chaos
```

`OPENTEAM_CHAOS_MIGRATE_BASE` can select a compatible migration runtime image. Each run creates
a random Compose project, private volumes, synthetic credentials, a deterministic local model
provider, and a random loopback API port. It never selects an existing installation. The cleanup
removes that project's containers, volumes and temporary image tags. Normal assertion failures
also run cleanup. An external force-kill cannot run that cleanup; the project name is recorded
in the output for manual cleanup if needed.

| Injected fault | Expected health | Expected doctor |
| --- | --- | --- |
| Worker stopped | Fails | Missing/stopped worker |
| Worker event loop frozen with SIGSTOP | Fails | Stale heartbeat or failed queue round trip |
| Worker diagnostic socket missing | Fails | Queue round trip fails |
| PostgreSQL paused | Fails within probe timeouts | Database unavailable |
| Application `Bot` table renamed | Fails | Application schema query fails |
| Queue metadata table renamed | Fails | Queue/database query fails |
| Shared asset volume permissions denied | Fails worker check | Service storage fails |
| Agent workspace permissions denied | Fails computer readiness | Computer/storage fails |
| Computer stopped | Fails | Computer unavailable |
| Computer control token mismatched | Fails | Authenticated computer request rejected |
| Model provider returns 401 | Local services remain ready | Provider authentication fails |
| Model provider returns 429 | Local services remain ready | Quota/rate limit fails |
| Model provider returns 503 | Local services remain ready | Model request fails |

Every fault is followed by restoration and successful health **and** doctor checks. The full
canary runs before faults and again after all recoveries. The runner requires the expected
failed doctor row, not merely a matching word somewhere in its output. Docker polling is
accelerated to two seconds with one failed attempt for the tests; measured run durations are
not production detection-latency guarantees.

Reports are written under `output/health-chaos/<run-id>/`: `results.json`, fault and recovery
health/doctor reports, build/startup logs, and cleanup results. During development this suite
also caught a test recovery command restarting completed setup dependencies and resetting
workspace permissions; recovery now starts only the exact faulted container.

## Fast regression and CLI UI tests

```sh
cd apps/cli
bun test ./test
bun run preview:status --gallery ../../output/status-ui
bun run preview:doctor --gallery ../../output/doctor-ui
```

The status matrix has 41 scenarios, tested through both aliases. The doctor suite includes
missing Docker, stopped engines, Compose versions, remote connection errors, corrupt config,
container failures and recovery instructions. CLI tests cover ANSI/plain output, real
pseudo-terminals, six widths from 24 to 110 columns, snapshots, and redaction.

Worker unit tests inject stale/invalid heartbeats, missing/hung sockets, forged responses,
foreign consumers, missing dependencies and concurrent probes. Server tests cover dependency
outages and bounded queries. Computer tests verify file I/O, denied permissions, cleanup and
probe coalescing. The Docker chaos run additionally validates Linux service identities and
real SQL/queue/network behavior that mocked tests cannot establish.
