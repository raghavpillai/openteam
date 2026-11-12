# T3 Code MCP integration design

Research and implementation date: 2026-11-12. Status: plugin implemented and tested in the worktree; not deployed to the running OpenTeam server. Optional platform proposals below remain design items.

## Implementation and verification

The bundled package now exists at [packages/plugins/t3-code](../../packages/plugins/t3-code/README.md), with one remote OAuth connection and three skills. Setup collects the full per-account MCP URL, validates HTTPS/loopback and rejects credentials or approval-code links, saves before authorization, then requires authenticated MCP discovery for readiness. It does not store T3 approval codes. Desktop and iOS both defer authorization until required fields are saved. Generic endpoint support uses a required non-secret string field with `format: "mcp-url"` and `endpoint: "${mcpUrl}"`.

Verification completed:

- A 91-test SDK/plugin/OAuth regression run passed. Focused follow-up tests cover URL-field setup, avoiding premature authorization at install, account separation, no-refresh OAuth, endpoint-change invalidation, and preserving credential placeholders in legacy endpoints.
- A real Chromium test exercised Marketplace installation, invalid URL rejection before any OAuth request, valid URL save before OAuth, browser approval, manual callback completion, authenticated discovery, and an authenticated tool call against the disposable provider. It used the real UI, routes, database, and MCP client.
- A real external OAuth smoke test connected to the supplied T3 relay URL, completed dynamic registration and S256 PKCE with temporary scoped host pairing, and discovered 68 tools. Actual tool results reported server version `0.1.8` and runtime ceiling `auto`; project listing and an existing thread read succeeded. No refresh token was issued. The temporary OAuth grant was revoked and the isolated OpenTeam installation removed.
- With the user's explicit authorization, a disposable scratch thread ran through the same external OAuth/MCP path on Codex `gpt-6.1-sol` in Auto mode. It created an addition module and two assertions, ran them successfully, and returned its final response through `t3_thread_wait`/`t3_thread_read`. An independent Node execution also exited 0. Retrying launch with the same key returned the same thread and run. A queued follow-up started a 120-second foreground command; interruption reached terminal `interrupted` state, its process exited, and its late-completion marker was absent. The thread was archived and the temporary grant revoked.
- That live coding test exposed a host redaction bug: public OAuth response metadata containing `"code"` was masking the substring in `codex`, making the provider unusable. Result redaction now collects actual OAuth credentials instead of public metadata; regression tests cover intact provider IDs/prose/links and continued token, secret, verifier and header redaction.
- After that fix, all 18 focused OAuth/transport/lifecycle/redaction regressions, server TypeScript checks, and the server production build passed. The disposable acceptance thread was archived after verifying the successful coding result and the deliberately interrupted follow-up; private environment and thread identifiers are omitted from this public report.
- Six native Swift form-validation tests passed, including the new HTTPS/loopback MCP URL checks. Changed SwiftUI sources passed parsing. Server, desktop and worker TypeScript checks passed; server and desktop renderer production builds passed. All three skills passed the skill validator, and package export/import preserves their worker routing and supporting files.

The real smoke tests cover connection, access mode, reads, a coding launch, idempotent launch retry, completion/result retrieval, independent file testing, queued follow-up and live remote cancellation. No user repository was changed. The T3 run and process cancellation were verified; the generic OpenTeam Stop button is still distinct from the explicit plugin remote-stop workflow. Full conversational skill selection and OpenTeam worker continuation were not model-driven in this smoke test. The running production OpenTeam installation was not upgraded by this work.

## Chaos and recovery verification

The fault-injection passes use isolated HTTP providers, the real MCP SDK, and a disposable PostgreSQL database. They do not disrupt the user's T3 relay or repositories. The [transport chaos tests](../../apps/server/test/plugin/mcp-chaos.test.ts), [OAuth transport chaos tests](../../apps/server/test/plugin/mcp-auth-chaos.test.ts), and [T3 authorization chaos tests](../../apps/server/test/plugin/t3-chaos.integration.test.ts) now contain 52 scenarios, including 25 repeated connection generations with 12 concurrent discovery/tool requests per generation. The [OAuth provider tests](../../apps/server/test/plugin/oauth-provider.test.ts) add 10 fault/concurrency scenarios alongside three ordinary provider-contract tests.

| Injected failure or race | Verified behavior |
| --- | --- |
| 20 simultaneous first discoveries | One shared initialization; all callers receive tools. The original implementation created 20 sessions. |
| Disconnect during blocked initialization | The old attempt rejects and cannot restore its session; a deliberate later connection succeeds. |
| New endpoint overtakes an old initialization | The old attempt cannot overwrite the newer session. |
| Legacy SSE stalls before sending response headers | Disconnect/shutdown aborts startup. Startup also has a 30-second overall deadline, covering transport startup as well as MCP initialization. |
| Repeated close/reconnect bursts | Cancelled generations reject; surviving generations keep one reusable session. |
| Provider returns HTTP 503, during startup or a tool request | Failure is surfaced; recovery works after the provider returns. A transient outage does not erase an OAuth grant. |
| Provider applies a write but returns a failed response | The host does not automatically replay the write. The synthetic provider demonstrates deduplication when the caller explicitly retries its stable request ID. Real T3 launch retry was separately verified in the live test above. |
| Caller aborts a blocked tool request | MCP cancellation is sent and the connection remains usable. Remote process termination is supported by the earlier live T3 cancellation test, not inferred from this fixture. |
| Five simultaneous calls encounter a revoked no-refresh grant | The account transitions once to `needs_auth`, drops the rejected token, records one recovery activity, dispatches no tools, and recovers after explicit sign-in. No orphan authorization URL or verifier is created. |
| Temporary refresh-server error versus rejected refresh grant | Temporary failure preserves credentials for retry; `invalid_grant` requires sign-in. |
| Delayed callback arrives after disconnect | It cannot restore credentials or account readiness. |
| Stale authorization failure or tools-changed callback arrives after a new sign-in | The current generation, credentials, and tool snapshot survive. |
| A real agent invocation encounters a revoked grant | The invocation is recorded as failed and no provider tool is dispatched. |

These tests reproduced defects before fixes: duplicate sessions, initialization surviving disconnect, an obsolete endpoint winning a race, stalled SSE startup ignoring shutdown, and revoked grants remaining visibly connected. The connection manager now shares startup attempts, invalidates and aborts pending attempts, fences tool updates by client identity and persisted runtime generation, and evicts clients on closure rather than on every recoverable transport error. HTTP OAuth recovery uses the existing connection generation and a database row lock so concurrent or stale failures cannot erase a newer authorization. The provider refuses SDK-initiated interactive authorization without a user-created state session; transient refresh errors retain the existing grant. Full package checks also caught and corrected the new package's missing `upstream.json` origin declaration.

First-pass verification: the broad plugin/SDK/package/worker/task-recovery regression run finished with **332 passed, 9 skipped, 0 failed** across 73 files. Its final server plugin rerun finished with **219 passed, 3 skipped, 0 failed** across 43 files, including the original 16 chaos scenarios. The real Chromium setup/approval/callback/tool-call flow, server TypeScript check, and production build passed. Skipped tests remain excluded coverage rather than successes.

### Second fault-injection pass

The next pass added 12 regression cases and reproduced four more defects before fixing them:

- **Expired MCP session:** after a remote session disappears, the SDK reports HTTP 404 but the manager kept reusing that session indefinitely. Discovery and tool errors now discard only the exact expired client. The next explicit request initializes a new session. The failed tool call is never automatically replayed.
- **Cancellation during startup:** an abort signal previously reached only the eventual tool request, leaving its caller blocked while shared initialization ran. Cancellation now stops that caller's wait promptly without aborting another caller's shared connection startup. Already-cancelled calls send no requests.
- **Credentials in provider diagnostics:** error response bodies could echo a credential into the settings API and saved invocation history. Errors are now scrubbed before storage or return. Redaction also reads the current saved credentials to cover a token refreshed during the call; successful results use the same current-credential scrubbing. Tests use disposable synthetic credentials.
- **Rejected credential save:** the OAuth provider updated its in-memory state before persistence succeeded. A failed database save could therefore change the active token and contaminate a subsequent save. In-memory authorization now changes only after the save succeeds.

Additional passing probes cover a truncated HTTP 200 response after applying a write, discovery after session expiry, browser callback completion in a fresh host service, interruption between token persistence and the ready transition, and eight simultaneous callbacks redeeming one code exactly once. The host-service replacement tests reconstruct the plugin service and MCP manager from persisted state; they are not an OS-level process-kill or full conversational worker-recovery test.

Second-pass verification: the complete server plugin suite finished with **231 passed, 3 skipped, 0 failed** across 43 files (234 tests), including all new cases. The real Chromium setup/approval/callback/tool-call flow passed again. Server TypeScript checking and the production build passed; the build validated and packaged 19 plugins.

### Third fault-injection pass

This pass added 14 cases and reproduced four further failure classes:

- **Access changed after preparation:** a prepared HTTP call could still use an old connection after disconnect or endpoint replacement. The manager now validates access before replacing a cached session and immediately before network requests. MCP tool dispatch checks the current connection generation, installation availability, readiness, and tool snapshot. Passing tests cover disconnect, endpoint replacement, installation becoming unavailable, tool removal, uninstall, and successful reauthorization before the old call resumes. A rejected stale request cannot evict the newer cached session.
- **OAuth was outside shutdown control:** blocked client registration and token exchange ignored connection closure. OAuth phases are now tracked, cancellable by close/shutdown, and bounded by a 30-second phase deadline. Tests block both phases and verify prompt cancellation; a shorter injected deadline verifies timeout behavior without a long test sleep. Setup cancellation does not undo a grant already accepted by the remote authorization server.
- **A killed host left an invocation running forever:** a separate Bun host process dispatches a synthetic MCP call, is killed with SIGKILL after remote acceptance, and then the real startup recovery function runs against PostgreSQL. Recovery now marks pending calls owned by interrupted runs as failed with an explicit *unknown remote outcome*. It preserves completed receipts, is idempotent, and rejects replay with `plugin_call_outcome_unknown`. It neither declares the remote operation failed nor sends it again. The agent must reconcile saved thread/run/request identifiers.
- **Cancellation stopped at the service boundary:** the SDK handled cancellation, but the plugin and internal-tool services dropped the signal. Signals now pass from internal tool execution through the invocation and transport layers to HTTP MCP and the stdio RPC. A real HTTP disconnect test uses the same request/Effect adapter as the dynamic-tool route and verifies that the underlying invocation settles instead of remaining blocked. This cancels a request or observer; explicitly interrupting a T3 coding run remains a separate operation.

Additional shutdown checks cover blocked access validation and preserve the original repeated close/reconnect stress test. The new dispatch validation exposed an ordering regression during implementation; the existing stress test caught it, and pending attempts are now registered before awaiting validation so shutdown can fence and abort them.

The third-pass regression command enables both `OPENTEAM_TEST_DATABASE_URL` and `OPENTEAM_RECOVERY_TEST_DATABASE_URL`. The latter is required by the dedicated startup-task tests; those six checks were skipped in the earlier broad run and are now exercised against the disposable database. The final run finished with **282 passed, 3 skipped, 0 failed** across 50 files (285 tests), including all 41 chaos scenarios and task/startup recovery. The three skips are optional provider-original, Granola, and Notion integration suites. Server TypeScript checking, the production build (19 packages), and the real Chromium setup/approval/callback/tool-call flow all passed again.

This coverage is not proof of 100% reliability or an exhaustive list of possible defects. It verifies controlled failure behavior in a single-host deployment, including a real process kill, plus the earlier live T3 acceptance run. It does not establish multi-server failover, sustained production load, arbitrary network partitions, or exactly-once delivery across OpenTeam and T3. The generic task continuation/startup-recovery regression suites are included in verification, but a model-driven OpenTeam conversation that survives restart mid-T3-job and delivers one final notification remains a separate release acceptance check. Changes remain in this worktree and are not deployed.

### Fresh receipt-persistence check

Three additional fault cases reproduced issues around the boundary between a completed remote call and its local result record:

- If the result transaction committed but its acknowledgement was lost, the catch handler overwrote the completed receipt as failed. It now reads the original receipt and returns the saved result when completion is confirmed. A repeat request reads that receipt without dispatching the operation again.
- If the remote response arrived but the result transaction did not commit, the API returned an ordinary database error. It now reports `plugin_call_outcome_unknown`, preserves an explicit reconciliation instruction in the failed local receipt when storage is available, and blocks automatic replay. Failure to write diagnostics cannot replace the primary outcome.
- A late result used the caller-selected call ID to update its receipt. Removing that receipt and reusing the call ID for a different run could let the old result overwrite the replacement. Claims, completion updates, failure updates, and reconciliation now use the immutable invocation row ID. The replacement receipt remains intact.

These cases use the real invocation service and database with injected failures immediately before commit, immediately after a successful commit, and between remote acceptance and local completion. All three failed before their corresponding fixes and passed afterward.

Fresh verification finished with **285 passed, 3 skipped, 0 failed** across 50 files (288 tests), including all 44 chaos scenarios. Server TypeScript, the production build (19 packages), and the real Chromium setup/approval/callback/tool-call flow passed. No covered regression remains failing; the unverified acceptance and deployment limits above still apply.

### Unpersisted OAuth secrets and active cleanup

Two further tests reproduced a redaction gap when persisting a new PKCE verifier or issued token failed. The write diagnostic could contain that new value, but the later error redactor only knew credentials already stored in the database. The original error and account status could therefore expose a secret that never successfully persisted. The OAuth provider now converts persistence failures to a safe public sign-in error at the write boundary, without including the original diagnostic or cause. The known stale-session error retains its actionable code and a fixed public message. Failed saves still leave in-memory authorization unchanged. Tests assert that neither returned errors, stored status messages, nor plugin settings contain the disposable generated secret.

Three additional passing probes remove/reset an account or uninstall the plugin after a remote request is accepted but before its response arrives. The invocation settles without replay or leaked database errors. Resetting the last account clears its credentials; removing a sibling account or uninstalling deletes the old connection. All three prevent subsequent use of the old request.

Latest verification: **290 passed, 3 skipped, 0 failed** across 50 files (293 tests), including all 49 chaos scenarios. Server TypeScript, the production build (19 packages), and the real Chromium setup/approval/callback/tool-call flow passed again. These changes remain undeployed, with the same conversational and production-scale acceptance limits documented above.

### Concurrent OAuth writes and overlapping starts

This pass added 12 cases. Four failing probes showed that concurrent saves on one OAuth provider could lose metadata, restore an older access token after a delayed metadata write, or save an obsolete verifier/redirect after a token write completed sign-in. Provider writes now run in order and merge each patch into the last committed state. Interactive sign-in checks run when the queued write executes. A failed save does not poison later writes. Further checks cover all four credential-invalidation modes so older metadata writes cannot restore invalidated credentials.

Two more probes reproduced overlapping-start defects in the HTTP manager. Both starts could pass `close()` before registering their authorization controllers, leaving the older attempt untracked. Registering the new controller now cancels its predecessor atomically. In addition, redirect observation used to mutate the supplied provider's callback; one attempt's cleanup could erase the surviving attempt's observer when they shared a provider. Each attempt now observes its provider through a forwarding proxy without mutation. Tests verify shutdown cancels both attempts, the replacement completes authorization and discovery, and shared-provider reuse still produces the correct URL and PKCE exchange.

These are per-provider/per-manager concurrency guarantees. They do not establish cross-process refresh-token coordination or multi-server failover. The final regression run completed with **302 passed, 3 skipped, 0 failed** across 50 files (305 tests). Server TypeScript, the production build (19 packages), and the real Chromium setup/approval/callback/tool-call flow passed again. The changes remain undeployed, and full model-driven conversation recovery remains unverified.

### PR verification

After updating the branch onto current `main`, the expanded server/SDK/package/worker/recovery suite passed with **394 passed, 3 skipped, 0 failed** across 77 files (397 tests). The three skips are optional provider-original, Granola, and Notion integration suites. Workspace architecture checks passed, as did TypeScript for server, desktop, worker, and plugin SDK; six native Swift form-validation tests; all three skill validators; and native artwork consistency for 19 packages. Server and desktop renderer production builds passed. The real Chromium Marketplace → URL validation → browser approval → manual callback → authenticated discovery/tool-call flow passed again. Private acceptance-thread identifiers are omitted from this public document. The deployment and acceptance limits above remain in effect.

Reproduce the focused checks with `OPENTEAM_TEST_DATABASE_URL` pointing to a disposable database with the repository migrations applied. Run database-backed suites serially per database: existing lifecycle fixtures truncate shared tables and must not overlap separate test processes.

```sh
bun test apps/server/test/plugin/mcp-chaos.test.ts apps/server/test/plugin/mcp-auth-chaos.test.ts apps/server/test/plugin/t3-chaos.integration.test.ts
```

## Recommendation

Ship a bundled **T3 Code remote MCP plugin plus an orchestration skill**. Connect OpenTeam's existing HTTP MCP client directly to T3's official `/mcp` endpoint, using public-client OAuth with dynamic registration and PKCE. T3 owns the coding agents, provider authentication, repository checkouts, worktrees, commands, and thread history. OpenTeam owns the user conversation and its connection to T3.

The first release should let a bot discover projects and models, start a coding thread in an explicit worktree, read progress, send a follow-up, interrupt work, and return the actual result with its T3 link. Use an environment reachable from the **OpenTeam server**, preferably T3 Connect or HTTPS over a shared tailnet. Reuse OpenTeam's existing background Task and saved-progress continuation machinery to follow the T3 run and deliver its result after the main chat turn ends. A dedicated remote-job service is optional future infrastructure, not a prerequisite for this plugin.

This direction uses an interface T3 now explicitly supports for outside agents. A new stdio bridge around T3's internal WebSocket RPC would add a process, another credential store, and dependence on internal contracts without providing a needed first-release capability. [T1], [T2], [B1], [B2], [B3]

## User story and plugin scope

**As an OpenTeam user with a T3 Code environment, I want to ask my bot to do coding work on a repository, continue talking while it runs, and receive the verified result in the same conversation, with access to the full T3 thread.**

The product is one installable plugin containing a remote MCP connection, bundled skills, supporting reference files, and setup documentation. Users do not separately install the skills, configure a coding provider inside OpenTeam for this integration, or run another bridge service. They do need an existing T3 environment with a working provider and access to the repository. T3 continues to use that environment's provider authentication and settings. [T1], [T13]

### First-time setup

1. The user opens Marketplace and adds **T3 Code**. Its MCP connector and skills are installed together through the normal plugin lifecycle.
2. The plugin asks for the T3 environment's copied MCP URL and a recognizable account label, such as **Work Mac**. The desired UX accepts the complete URL; the generic setup improvements described below enable this.
3. The user signs in through T3's authorization page and chooses what OpenTeam may do. They do not create an API application or provide provider API keys. A read-only grant supports browsing; starting coding work requires an appropriate operating grant. T3's permission mode determines which execution steps still need human approval. [T1], [T14]
4. OpenTeam verifies the connection by reading the environment and available projects/providers. It can report “Connected to Work Mac; OpenBot is available.” It should not run a coding job just to validate setup.
5. Project/model preferences can come from the current request, T3 project defaults, or existing OpenTeam memory/account instructions. These are optional convenience settings, not more required setup fields. The main bot passes the resolved preferences to its worker because account custom instructions are not injected into workers automatically.

For a cloud or container deployment, recommend T3 Connect or another reachable HTTPS route. The setup should explain that the coding computer must stay online, rather than asking the user to debug container networking. [T1], [T11]

### A coding request

Example user request:

> Fix the crash when uploading a large file in OpenBot. Use Codex and work in a new branch.

The bot resolves the environment, repository, and requested provider. It asks a question only when the selection is materially ambiguous or task information is missing. It gives OpenTeam's existing background executor the task and the installed T3 workflow instructions. That executor starts a normal T3 thread with an explicit worktree strategy and records the returned identifiers before following the run.

The user sees a short acknowledgement and the real T3 thread link once launch is verified. They can inspect the work in T3 or continue using the OpenTeam conversation. The coding agent runs through T3; the OpenTeam worker coordinates and observes it.

While T3 is working, the worker uses bounded reads/waits. For longer external waits, it saves the run reference and unfinished obligations with OpenTeam's existing task-progress tool and a future check time. The host resumes that same task; a new check must not launch another T3 job. Meaningful milestones can return through OpenTeam's existing progress mechanism. There is no need for a visible “monitor” bot, new task dashboard, or mandatory routine.

When T3 finishes, the worker verifies the settled result and returns it to the main bot. The bot replies in the original conversation with what changed, what was tested, any remaining issue, and the T3 link. Include a PR link if a PR was part of the authorized task. Do not treat permission to fix code as permission to merge or deploy it.

### Continuing, checking, and stopping

- **“How is the upload fix going?”** Inspect the saved T3 thread/run and give observed progress. Do not create a new thread.
- **“Also cover empty uploads.”** Route the additional scope to the worker following that run or send a deliberate follow-up to the same T3 thread. Distinguish queued work from active steering.
- **“Show me what changed yesterday.”** Use the thread-browsing skill to find and summarize existing work; launching a coding agent is unnecessary.
- **“Stop the T3 upload fix.”** Interrupt the identified remote run, verify its state, then end local tracking. Stopping an OpenTeam helper by itself does not stop T3.

The existing generic OpenTeam Stop control is not evidence that a remote T3 interrupt occurred. Unless integration testing proves a stop-to-interrupt hook exists, keep the plugin's explicit remote-stop workflow and its result distinct from local task cancellation.

### Waiting for a person or a connection

- If T3 needs approval, the bot says the task needs attention and supplies its T3 link. The user approves in T3 and can say “continue checking” in OpenTeam. The plugin must not approve commands by answering a text question.
- If a repository or provider is missing, explain what must be configured in T3. Do not silently install providers or clone a different repository.
- If the host goes offline, keep the saved reference and report that progress is unavailable. Reconnect to the same work rather than launching a replacement.
- If authorization expires, show the existing plugin sign-in flow. Reconcile the saved thread after signing in before any retry that could start work.
- If the user connects another machine, add another account within the same plugin. Choose the environment explicitly when more than one could match.

These are proposed product behaviors. The underlying host capabilities were inspected, but the complete T3 workflow still needs end-to-end acceptance tests.

### Bundled skills

Start with three focused skills, installed and updated with the plugin:

| Skill | When it applies | Declared agents |
| --- | --- | --- |
| `t3-code` | New implementation, bug fixes, tests, or code research through T3; launch and follow the result | `main`, `executor` |
| `t3-threads` | Inspect existing work, check progress, continue a known thread, or explicitly stop a remote run | `main`, `executor` |
| `t3-setup` | Connect an environment or diagnose authorization, reachability, or missing provider/project setup | `main` |

Use clear trigger descriptions so ordinary coding requests select the integration when the user names T3 or an established T3-backed project. A request for generic coding must not silently switch from a user's explicitly chosen local workflow.

Put shared protocol details in supporting reference files. Skills explain how to select an account, retain the run reference, choose a worktree, interpret completion, handle approvals, and report results. MCP supplies the executable tools. Credentials remain in connection storage, and a default repository or preferred model belongs in user/account context rather than in the reusable skill text.

Explicit `agents: ["main", "executor"]` matters: the current host defaults plugin skills to the main agent only. OpenTeam already distributes declared skills and MCP accounts to executor workers, so the package can use that mechanism directly. These OpenTeam skills are not automatically installed into T3's coding providers; send task-specific constraints in the launch/follow-up message, and let T3's agents use the skills and repository instructions already available on their host.

### Scope of the first release

Keep the integration itself in `packages/plugins/t3-code`. Small generic improvements to collecting an endpoint before OAuth can still be needed for a polished setup form. A tool allowlist is optional host hardening, not a transport prerequisite or an authorization boundary supplied by a skill. A separate bridge, dedicated watcher service, provider implementation, or T3-specific database schema is not needed for the initial user story.

This refines the initial recommendation: a background result needs an owner, but OpenTeam already has Task ownership, saved waiting state, timed continuation, restart reconciliation, and completion delivery. Reuse and test those capabilities before proposing another subsystem. See [worker plugin context](../../apps/worker/src/plugins.ts), [worker dispatch](../../apps/worker/src/worker.ts), [skill routing](../../packages/messaging/src/plugin-skill-catalog.ts), [task progress and continuation](../../packages/messaging/src/task-progress.ts), and [startup recovery](../../apps/server/src/services/startup-recovery.ts).

## Evidence and boundaries

The research covered upstream user documentation, transport/authentication source, authorization tests, project and orchestration tool definitions, launch handlers, wait behavior, three independent bridge projects, the MCP specification, and OpenTeam's actual plugin implementation. Follow-up research traced plugin skills into executor workers, MCP tool availability, saved task-progress continuations, restart recovery, and the existing result-delivery path; those findings support the plugin-only product scope above.

- Initial OpenTeam research base: `4bb02542bd86ffe51fc14862b539951b1b5269d6`, on branch `codex/t3-code-mcp-research`, created from `origin/main`. The branch was fast-forwarded to current `main` before the PR verification below.
- Upstream T3 snapshot: `9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5`; its server package declares `0.1.9`. Source links below pin that commit.
- Installed T3 runtime: `0.1.8`, confirmed with the read-only `t3_environment_read` tool and the host's unauthenticated environment metadata.
- The installed runtime's public OAuth metadata was fetched without credentials. It advertises `/mcp`, dynamic registration, authorization-code flow, S256 PKCE, public-client token authentication (`none`), and `orchestration:read` / `orchestration:operate`.
- During the initial read-only research pass, live tool descriptions confirmed thread launch, send, wait, incremental reads, worktree selection, and launch retry keys through this agent's **internal provider session**.
- That initial pass created no OAuth grant or coding job. The later explicitly authorized outside-client OAuth, coding, retry, and cancellation acceptance tests are recorded in **Implementation and verification** above. Full model-driven conversation recovery remains unverified.

Public upstream and the installed runtime broadly agree on the proposed interface, but they are different versions. In particular, upstream's orchestration design prose still says launch has no retry key; its actual project tool schema and handler, as well as the installed tool description, support `clientRequestId`. Prefer verified schema and handler behavior over that stale sentence. Do not invent a minimum supported version from this single inspection. [T2], [T5], [T6], [T7]

## How the official MCP works

### Transport and ownership

T3 serves authenticated MCP over HTTP at the environment origin plus `/mcp`. Its source configures the MCP protocol revision `2025-06-18`. Use the SDK's Streamable HTTP transport and let it negotiate headers and session handling. SSE framing within Streamable HTTP is different from the legacy standalone HTTP+SSE transport; OpenTeam's existing legacy fallback is not a reason to add a T3 SSE URL. [T3], [M1]

MCP is an ingress to T3 application services. Project launch uses `ThreadLaunchService`; orchestration delegates thread lookup, send, waits, and interrupts through `ThreadManagementService`, with durable orchestration state underneath. An OpenTeam plugin should call these tools, rather than duplicate provider adapters or read T3's database. [T2], [T6]

There are two credential contexts:

1. **Inside T3:** T3 injects a bearer credential bound to an environment, thread, provider instance, and provider session. Tools can act as that parent thread. The injected `t3-code-direct` wait entry is a harness-specific presentation of the same server.
2. **Outside T3:** An OAuth-authorized application has a client session and permission ceiling, with no calling T3 thread. This is OpenTeam's context. Copying this coding session's token or its injected MCP configuration would be incorrect. [T2], [T8]

### Authentication and reachability

Use discovery through the MCP SDK. The inspected server advertises:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/oauth/mcp/register
/oauth/mcp/authorize
/oauth/mcp/token
```

These are observed paths, not endpoints to hardcode in a connector. Discover them from the supplied MCP URL and metadata. T3 accepts public clients registered dynamically, requires S256 PKCE, validates registered redirects, and issues a bearer session. HTTPS callbacks match exactly; loopback HTTP callbacks may vary by port. A custom pre-registered client ID or client secret is not part of this setup. [T4], [T9], [M2]

T3's consent page determines the approved access level. Read-only grants cannot mutate; other levels allow thread operations up to their runtime ceiling. An approval can cover **every project in that environment**. A saved preferred project in an OpenTeam skill is a routing preference, not project-scoped authorization. Requesting OAuth scope text does not replace T3's access-level consent. [T1], [T9], [T10]

The inspected OAuth implementation supports only `authorization_code` and returns no refresh token. The outside-agent documentation describes a 30-day sign-in, followed by reapproval, and revocation through T3's Sharing & access settings. Do not promise unattended token renewal, reuse a general T3 administrator session, or use the host CLI to silently mint replacements. OpenTeam should surface `needs_auth` when reauthorization is required. [T1], [T4]

Connection placement matters:

- A remote MCP call originates in `apps/server`, not in the user's desktop renderer or the bot computer.
- `localhost` in a container points to that container. It does not reach a T3 desktop process on the Mac.
- Prefer the environment's copied T3 Connect MCP URL for a server without access to the user's private network.
- Tailnet HTTPS works when the OpenTeam server can reach that tailnet. Plain HTTP at a LAN or Tailscale IP does not satisfy the documented outside-agent sign-in requirements.
- Host-local HTTP is suitable only when the actual client process can reach T3 through loopback.
- The T3 host must remain awake and reachable. T3's documentation says closing its desktop app's last window stops its local server; a background service is appropriate for unattended operation. Provisioning that service is a separate setup action. [T1], [T11]

### Tool selection for an outside client

Use this initial working set; discover schemas at runtime:

| Tool | Purpose |
| --- | --- |
| `t3_environment_read` | Identify the environment and server version |
| `orchestrator_capabilities` | Discover configured providers, models, options, and constraints |
| `t3_project_list`, `t3_project_read` | Resolve a registered repository and inspect its workspace |
| `t3_thread_list`, `t3_thread_search` | Find existing work and reconcile an uncertain launch |
| `t3_thread_launch` | Start a normal T3 thread with a defined workspace |
| `t3_thread_read` | Read state, recent runs, pending-request count, and paged content |
| `t3_thread_wait` | Wait for a specific run, optionally including delegated/background work |
| `t3_thread_send` | Send a queued follow-up or an explicit steering instruction |
| `t3_thread_interrupt` | Interrupt a selected active run |

Exclude thread-parent operations such as `delegate_task`, `task_status`, `task_cancel`, `create_threads`, worktree handoff, secrets, devices, and preview/rendering from the initial OpenTeam surface. Some still appear in outside-client discovery but reject calls that need a provider-session thread. OpenTeam should launch a top-level thread; that thread's agent can subsequently use T3's own delegation features. [T1], [T5], [T8]

Also leave project creation/deletion, scheduling, environment preferences, transfers, attachments, and PR administration out of the first workflow. They can be added independently when required. The repository must already be available to T3; an OpenTeam-local path is not automatically a T3-host path.

### Runs, completion, questions, and retries

A launch receipt means work was accepted, not finished. Persist the returned `threadId`, `runId`, and `link`. Read/wait by those identifiers.

Use `untilDelegatedWorkSettled: true` when advertised. A parent turn can finish while its delegated or background work continues. When the settled wait returns `resultRun`, use that run when locating the final answer. Follow `afterPosition` / `nextPosition` and text offsets to retrieve truncated content without repeatedly loading the whole timeline. [T7], [T12]

Outside clients do **not** inherit T3's parent-thread completion wake-up. The wait implementation emits its automatic-wake `next` instruction only for an owned delegated task with an internal parent. An OpenTeam thread launched through external OAuth has no such parent. A successful MCP call or a tools-changed notification is not a job-completion subscription. [T12]

For the first release, give an existing OpenTeam background Task responsibility for the result. Use bounded waits, for example 30–60 seconds, and inspect `waiting` or pending-request state between waits. For a longer external wait, save the receipt and remaining obligations with `ReportTaskProgress` and a future `checkAt`; OpenTeam already schedules continuation of that same task. The main conversation can end its current turn and receive the task's eventual result through its existing completion-delivery path. If no live or saved task owns delivery, report the actual running state and link without promising an automatic reply.

Initially route approvals and blocking questions to the T3 thread UI. `t3_pending_request` can be evaluated later for list/read/respond of user questions; its question responder cannot approve command or permission requests. Do not widen runtime mode to escape a pending approval.

A transport timeout, disconnect, or cancellation of a waiting MCP request does not prove the T3 run stopped. An explicit user request to stop work should invoke the advertised run-interrupt tool and verify the resulting state. [M1], [T12]

For launch and send, use a stable `clientRequestId` for retries of the same operation, and a new key for each new operation. The launch handler derives stable IDs from the credential's request namespace and key. Outside OAuth uses `client:<sessionId>`; reauthorization creates a different namespace. Therefore:

- Preserve the same key and unchanged payload while retrying within the same authorized session.
- After session replacement, reconcile saved thread/run IDs and read existing work before retrying a launch.
- For older servers without a launch retry key, never blindly retry an uncertain launch; reconcile or require an upgrade.
- Prefer `mode: "queue"` for a separate follow-up; `auto` may steer an active turn. Use explicit steering only when requested. [T6], [T8], [T12]

## What OpenTeam already provides

| Existing component | Reuse and implication |
| --- | --- |
| [Plugin package guide](../../packages/plugins/README.md), [plugin development](plugins.md) | Bundled, auto-discovered packages; remote MCP plus skills; multiple independent accounts |
| [HTTP MCP manager](../../apps/server/src/plugins/mcp-client-manager.ts) | Streamable HTTP, OAuth SDK integration, schema discovery pagination, transport reuse, tools-changed discovery, and long-call configuration |
| [OAuth provider](../../apps/server/src/plugins/oauth-provider.ts), [callback handling](../../apps/server/src/plugins/oauth-callback.ts) | Per-connection OAuth state, PKCE verifier storage, dynamic client information, server and loopback callback flows |
| [Plugin service](../../apps/server/src/services/plugin-service.ts) | Connection lifecycle, OAuth callback state/issuer checks, and discovered tool snapshots |
| [Transport](../../apps/server/src/services/plugin/transport.ts), [invocations](../../apps/server/src/services/plugin/invocations.ts) | Credential redaction, invocation receipts, and account/tool checks |
| [Configuration](../../apps/server/src/services/plugin/configuration.ts), [values](../../apps/server/src/services/plugin/values.ts) | Typed per-account values, endpoint substitution, endpoint changes invalidating OAuth state |
| [Plugin types](../../packages/plugin-sdk/src/types.ts), [validator](../../packages/plugin-sdk/src/manifest.ts) | Portable manifests and setup contracts |
| [Result handling](../../apps/computer/src/runtime/connector-results.ts) | MCP content/error propagation and large-text spill to files |

OpenTeam pins `@modelcontextprotocol/sdk` to `1.30.0`. The shared tool-call timeout is already one hour, and HTTP fetch disables Bun's quiet-call timeout. This is transport capacity. Existing `PluginInvocation` records describe a tool call, not the eventual completion of the coding thread it starts; background ownership comes from OpenTeam's separate Task and task-progress mechanisms.

Packaged stdio connectors run on the bot computer through [McpRuntimeRouter](../../apps/computer/src/mcp-runtime-router.ts). Moving a bridge there would not automatically put it on the user's T3 host or give it access to that host's repositories and credentials.

## Concrete implementation

### Package and endpoint setup

Add:

```text
packages/plugins/t3-code/
  plugin.json
  README.md
  skills/t3-code/SKILL.md
  skills/t3-code/references/orchestration.md
  skills/t3-threads/SKILL.md
  skills/t3-setup/SKILL.md
  assets/icon.png
```

Use category `Agent Orchestration`, components `["mcp", "skills"]`, one HTTP/OAuth connector, public client, dynamic registration, `tokenEndpointAuthMethod: "none"`, and `shareClientCredentials: false`. Publish it as an OpenTeam integration for T3 Code; do not imply T3 published the package.

Use one OpenTeam account per T3 environment/authorization, labelled with the machine's name. Keep credentials independent. Linked-environment routing is optional beta functionality upstream and is unnecessary for the initial integration. Discover provider/model choices rather than shipping a model-name list.

The setup input is the **complete copied MCP URL**, followed by browser authorization. The implementation resolves these two limitations found during research:

1. The original manifest validator required a literal HTTP(S) prefix. It now accepts a whole-endpoint placeholder only when it refers to a required non-secret `mcp-url` field.
2. The original compact OAuth form proceeded without saving arbitrary fields. It now validates/saves those fields before authorization, and installation waits for required connector fields. See [setup form](../../apps/desktop/src/renderer/components/openteam/plugin-detail-view.tsx). Mobile preserves the endpoint template when saving its URL field.

The implemented URL flow accepts HTTPS and HTTP loopback and rejects embedded credentials, fragments, approval-code queries, missing values, and plain HTTP remote addresses. Callback and PKCE fields remain host-controlled. Successful URL validation alone is not proof of a live connection: authenticated tool discovery is required.

A template-compatible pilot can instead use `endpoint: "https://${T3_HOST}/mcp"` with a required hostname field, saving it through existing advanced settings before authorization. The fragment below fits today's manifest format; it is a design example, not an installed plugin:

```json
{
  "key": "t3-code",
  "name": "T3 Code",
  "transport": "http",
  "auth": "oauth",
  "endpoint": "https://${T3_HOST}/mcp",
  "tools": [],
  "setup": {
    "kind": "oauth",
    "connectionKey": "t3-code",
    "title": "Connect T3 Code",
    "description": "Connect an existing T3 Code environment.",
    "documentationUrl": "https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md",
    "steps": [
      "Save the hostname from your copied T3 MCP URL in account settings.",
      "Authorize OpenTeam in T3 Code, then return to OpenTeam."
    ],
    "fields": [
      {
        "key": "T3_HOST",
        "label": "T3 environment hostname",
        "required": true,
        "secret": false,
        "placeholder": "your-environment.example"
      }
    ],
    "requiredScopes": ["orchestration:read", "orchestration:operate"]
  },
  "oauth": {
    "clientType": "public",
    "registration": "dynamic",
    "tokenEndpointAuthMethod": "none",
    "shareClientCredentials": false
  }
}
```

This fragment's `tools: []` means tools will be discovered. It does **not** implement the tool policy below.

### Optional generic tool policy

Current manifests have no tool allowlist policy. The `tools` array supplies initial definitions; connection discovery replaces the snapshot, and tool-change notifications refresh it. Listing only desired tools in a manifest would not restrict future discovery.

The first plugin can use the current discovered tools and instruct its skills to use only supported outside-client operations. That is guidance, not enforcement. If a restricted tool surface is a release requirement, add a small, reusable connector policy, for example `toolPolicy: { allow: [...] }`, with exact names from the initial working set. This is a proposed schema extension. Filter discovery and refresh results before they become bot-visible; enforce the same policy at invocation and immediately before execution so stale snapshots cannot bypass it. Default to existing behavior when no policy is declared. Test policy changes and reconnects.

Keep T3-specific tool names and workflow instructions inside its package. Do not add T3 imports or dispatch cases to `apps/server`. Tool risk remains derived from MCP annotations, and T3's approved access level remains the actual remote authority. A tool allowlist does not constrain what a launched coding agent can do inside its allowed runtime mode.

### Orchestration skill

Teach this workflow:

1. Resolve the correct connected environment and registered project. Read existing work when the request references it.
2. Discover available providers/models and honor the user's selection. Leave the model unspecified when the project default is appropriate.
3. For independent code changes, launch with explicit `workspaceStrategy: { type: "worktree", baseRef: "<remote>/<default-branch>", startFromOrigin: true }`; discover the actual branch. For dependent unpublished work, use its local base with `startFromOrigin: false`. T3 creates and binds the checkout before starting its agent.
4. State the task, constraints, acceptance criteria, and intended output in the launch message. Include a stable request key.
5. Save the launch receipt. Wait/read the exact run; account for delegated work and pending human input.
6. Read the final response and summarize actual changes, validation, remaining issues, and PR links where present. Preserve the server-returned T3 link verbatim. Outside clients receive a hosted HTTPS thread link rather than the internal `t3-thread://` format.
7. Send subsequent work to that thread with explicit queue/steering intent. Interrupt only when requested or required by an authorized cancellation workflow.

Do not copy the full internal T3 orchestration prompt into OpenTeam: it assumes an active provider-session parent and automatic wake semantics that OpenTeam does not have.

### Background results through existing Tasks

Reuse the existing OpenTeam executor Task, not T3's internal `delegate_task`. The worker receives the parent's MCP accounts and any skills explicitly declared for `executor`. On completion, OpenTeam's normal background-result path wakes the main bot in the originating conversation.

Record `connectionId`, observed `environmentId`, `projectId`, `threadId`, original `runId`, `clientRequestId`, returned `link`, read cursor, and settled `resultRunId` in the existing task's evidence/continuation context. Never record credentials. Save the intended operation and stable retry key before launch, then checkpoint the returned receipt promptly. If interrupted between acceptance and receipt storage, reconcile the same operation rather than launching blindly.

`ReportTaskProgress` already supports `working`, `waiting`, `blocked`, and `complete`, evidence, remaining obligations, `nextAction`, and a future `checkAt`. A waiting report ends the worker turn, and `dispatchTaskContinuations` schedules its continuation. Startup recovery uses the saved obligations to request reconciliation after a runtime interruption, with bounded recovery attempts. Those are existing generic host capabilities; the plugin needs instructions and end-to-end validation, not a new table for the first release.

The worker should pin the remote run, use bounded reads/waits, checkpoint long external waits, surface human-input states, and return the verified result once. Clear remaining obligations only after the required result is established. A local task finishing or a tool call succeeding is not sufficient evidence that the remote job succeeded.

On account removal/disconnect, prevent further credential use and report the observation failure. Do not silently cancel a remote coding job merely because observation stopped. An explicit remote-stop request should interrupt the saved T3 run and reconcile its state before stopping local tracking. Reauthorization must reconcile IDs before new launches because the remote retry namespace changes.

Existing task continuation is not a blanket guarantee of indefinitely running jobs, exactly-once cross-system execution, or synchronous remote cancellation from the generic Stop button. Test restart, timeout, revocation, cancellation, and duplicate-delivery cases against the intended product promise. A deterministic remote-job broker can remain a later generic optimization if actual operation justifies it.

The existing plugin event contract supports only packaged email polling; do not pretend it supplies T3 completion events. The proposed plugin uses MCP observation plus the existing OpenTeam Task lifecycle.

## Delivery sequence and release checks

1. **Compatibility spike:** connect a disposable environment through the existing custom remote-MCP settings with OAuth and no client credentials. Complete discovery and one read. This isolates auth/reachability from package work.
2. **Bundled integration:** add package, the three skills with explicit worker routing, and endpoint setup improvements. Prove a real launch → wait → final-result workflow in an isolated T3 repository.
3. **Background acceptance:** exercise the existing Task/progress continuation and result-delivery paths while the main chat is free. Add tool-policy enforcement only if the release requires it; add no new task UI or dedicated job service by default.

Acceptance should cover behavior, not snapshots of today's tool names alone:

- Dynamic registration and PKCE work with a public client and no refresh token. Check HTTPS server callbacks and desktop loopback callbacks; invalid state/issuer and stale attempts remain rejected.
- A copied URL works from the OpenTeam server's deployment network. Give a useful error for host/container loopback confusion and an offline T3 host.
- Changing endpoint invalidates authorization; a second account never reuses the first environment's credentials. A globally configured manual OAuth client must not override this integration's required dynamic registration.
- Read-only grants can inspect but cannot launch/send/interrupt. Broader grants cannot launch above the approved runtime mode.
- If a tool allowlist ships, only the declared tool set appears after discovery, reconnect, and tools-changed notifications; direct invocation of an excluded tool is refused. Without that feature, verify the skill uses the documented outside-client workflow and do not claim a restricted tool surface.
- New work uses the requested checkout and actual default branch. Project defaults and explicitly selected provider/model settings reach T3 unchanged.
- Retry a lost launch response with the same key in the same session: one thread/run. Reauthorization after an uncertain launch reconciles saved work instead of duplicating it.
- Pin waits to the intended run. A later queued turn must not replace the result accidentally. Delegated/background work and `resultRun` are handled.
- Questions/approvals are shown as waiting with a working T3 link; timeouts remain running. Explicit stop interrupts the remote run.
- Preserve MCP `isError`, typed failures, pagination/text offsets, and server links. Unknown/unsupported capabilities produce a clear compatibility error.
- For existing Task-based monitoring: verify both skills and MCP tools reach the executor, save a waiting checkpoint, restart OpenTeam mid-job, revoke OAuth, interrupt network access, remove an account, and repeat completion delivery. Verify recovery resumes observation of the saved remote run and produces one final notification. Explicitly test that a user request to stop T3 work interrupts the remote run rather than merely stopping its observer.

The implementation reuses [transport fixtures](../../apps/server/test/plugin/mcp-transport.test.ts) and the [OAuth fixture](../../apps/server/test/plugin/fixtures/oauth-mcp.ts), including authorization-code-only/no-refresh coverage. See [the T3 lifecycle test](../../apps/server/test/plugin/t3-code.integration.test.ts), [result-redaction regression](../../apps/server/test/plugin/result-redaction.test.ts), [browser setup test](../../apps/desktop/test/t3-code-ui.e2e.ts), and the real coding/cancellation results above.

## Alternatives investigated

- **Official remote MCP:** recommended. Explicit outside-agent support, native OAuth, worktree-aware launch, and durable thread/run reads.
- **JulianBeaulieu/t3code-mcp:** a separate stdio server wrapping WebSocket RPC, configured with a pairing credential. Its additional lifecycle and internal API dependency are unnecessary for this integration. [B1]
- **gfsaaser24/t3-code-agent-mcp:** a more detailed HTTP/WebSocket bridge, whose README pins compatibility to T3 `0.0.40` / upstream `8419238`. Useful historical integration evidence, but not the current official outside-client contract. [B2]
- **scratchyone/t3-code-mcp:** a multi-machine bridge using undocumented endpoints and host CLI-based session renewal. Its “no official public API” statement describes that bridge's integration approach; it does not override current upstream MCP documentation. [B3]
- **Host CLI wrapper:** T3 documents `t3 thread` for host-local scripts. It can serve an explicitly host-local automation need, but would require OpenTeam to run on or remotely control that host, parse another interface, and manage its process lifecycle. It is not the default remote plugin. [T1]

The recommended first implementation is therefore one remote plugin with bundled skills, targeted generic setup improvements, and OpenTeam's existing background Task machinery. Keep coding execution and provider integrations in T3. Treat a dedicated remote-job broker and tool-policy enforcement as separate optional improvements with explicit requirements.

## Sources

Upstream links pin the inspected snapshot unless explicitly marked otherwise.

[T1]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/docs/user/outside-agents.md "T3 outside-agent setup, permissions, limitations, and host CLI"
[T2]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/docs/orchestration-v2/orchestrator-mcp-server.md "T3 orchestration architecture; launch retry prose is stale"
[T3]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/apps/server/src/mcp/McpHttpServer.ts "HTTP MCP transport and authentication"
[T4]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/apps/server/src/auth/McpOAuth.ts "OAuth metadata, registration, PKCE, tokens, and external request namespace"
[T5]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/apps/server/src/mcp/toolkits/project/tools.ts "Authoritative thread launch input/output and project tools"
[T6]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/apps/server/src/mcp/toolkits/project/handlers.ts "Launch request-key derivation and replay"
[T7]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/packages/contracts/src/orchestratorMcp.ts "Wait, read, send, and task contracts"
[T8]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/apps/server/src/mcp/McpInvocationContext.ts "Client/thread contexts, permission ceilings, and external links"
[T9]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/apps/server/src/auth/McpOAuth.test.ts "OAuth authorization and registration tests"
[T10]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/apps/server/src/mcp/McpToolAccess.ts "Tool access enforcement"
[T11]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/docs/user/remote-access.md "Reachability, T3 Connect, and background host lifecycle"
[T12]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/apps/server/src/mcp/OrchestratorMcpService.ts "Thread waits, completion wake conditions, and send behavior"
[T13]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/README.md "T3 controls locally configured coding agents and provider subscriptions"
[T14]: https://github.com/pingdotgg/t3code/blob/9771c5fd2df6568c7a4ac8a2263ed1e58535f9b5/docs/user/permission-modes.md "T3 permission modes and human approval"
[B1]: https://github.com/JulianBeaulieu/t3code-mcp "Third-party WebSocket MCP bridge"
[B2]: https://github.com/gfsaaser24/t3-code-agent-mcp "Third-party host-local HTTP/WebSocket bridge"
[B3]: https://github.com/scratchyone/t3-code-mcp "Third-party multi-machine MCP bridge"
[M1]: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports "MCP transport revision used by inspected T3 source"
[M2]: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization "MCP authorization revision used for this compatibility analysis"
