# Computer/server refactor audit

Date: 2026-09-04

## Scope and outcome

Audited `apps/computer/src` and `apps/server/src`, their tests, workspace dependencies, and existing architecture checks. Preserved the working-tree baseline and did not change database schemas, dependency versions, public HTTP paths, model-visible tool definitions, approval policies, or persistence formats.

The final inventory contains **12** production files above 750 lines (correcting the preliminary estimate of 13). All production TypeScript files in these two apps are now **750 lines or fewer**, including extracted modules.

**LoC caveat:** physical production-source lines changed from **24,459 to 24,986** (**+527, 2.2%**). Repeated implementations were consolidated, but explicit imports, typed boundaries, and compatibility entry points outweighed those savings. This pass achieves the modularization/readability objective, **not a net physical-LoC reduction**. No functionality, validation, safety checks, or tests were removed to lower the count.

## Oversized files

Counts include comments, imports, and blank lines; generated code and tests are excluded.

| Original entry point | Before | After |
| --- | ---: | ---: |
| `apps/computer/src/bot-agent-store.ts` | 1,435 | 722 |
| `apps/computer/src/bot-compaction.ts` | 1,584 | 53 |
| `apps/computer/src/box-store-sync.ts` | 824 | 718 |
| `apps/computer/src/browser/broker.ts` | 892 | 430 |
| `apps/computer/src/browser/use.ts` | 926 | 628 |
| `apps/computer/src/runtime.ts` | 2,307 | 750 |
| `apps/computer/src/screen-broker.ts` | 946 | 640 |
| `apps/server/src/app-service.ts` | 1,085 | 627 |
| `apps/server/src/main.ts` | 1,131 | 208 |
| `apps/server/src/services/channel-service.ts` | 1,323 | 548 |
| `apps/server/src/services/plugin-service.ts` | 2,129 | 636 |
| `apps/server/src/services/snapshot-service.ts` | 1,118 | 691 |

The entry-point reductions are relocations plus deduplication, not deletions of the corresponding features.

## Responsibility boundaries

- **Computer runtime:** turn lifecycle stays in `runtime.ts`; attachments, event projection, tool execution, dynamic catalog construction, compaction hooks, and session-path validation live in `runtime/`.
- **Agent storage:** handle leasing/LRU/close coordination stays in `bot-agent-store.ts`; recovery, inventory discovery, record publication, and derived projections live in `agent-store/`.
- **Compaction:** archive durability, summary/message rules, and coordinator state are separated under `compaction/`, with the existing import path retained.
- **Browser:** CDP transport, cookie normalization, origin-state scripts, Playwright startup, and tool definitions have independent modules.
- **Screens and replication:** process/endpoint helpers and computer-use action translation live under `screen/`; box-store manifest utilities are separate from synchronization orchestration.
- **Server:** authentication and public/internal access boundaries stay in `main.ts`; domain handlers live under `routes/`. Startup recovery and settings are separate from application wiring.
- **Services:** plugin queries, transport, installations, access, invocations, and connector delivery are separate collaborators; group administration and direct-profile changes are separate from message delivery; snapshot queries/projections and runtime health are separate from snapshot assembly.

## Shared implementations

- 82 lazy promise Effects use one error-normalizing adapter.
- 95 pass-through service methods use a typed lazy forwarder; only already-bound arrow methods were converted, preserving constructor timing and detached-call behavior.
- 50 simple HTTP routes share method/path matching, body validation, Effect execution, and JSON response handling.
- 27 closed object tool schemas share a builder that preserves omitted versus empty `required` lists.
- 11 first-party dynamic tools share schema/dispatch construction.
- Channel, rich-message, and snapshot output share one message mapper. Metadata copying, directory provisioning, snapshot roster queries, and compaction-event projection are also shared.

Similar-looking atomic file writes, hashing/canonicalization policies, and authorization flows were deliberately kept distinct where durability or behavioral contracts differ.

## QA

| Check | Result |
| --- | --- |
| Forced computer/server test tasks | **292 passed, 0 failed**: computer 143; server 149 |
| Opt-in PostgreSQL integration fixtures | **4 passed**, each run separately against a newly initialized disposable local database |
| Before/after HTTP differential corpus | **3,195 comparisons matched**: service calls, responses, status/headers, malformed input, encoded IDs, and query validation |
| Browser and dynamic-tool schema parity | Baseline SHA-256 fixtures match exact serialized schemas/descriptions/order |
| Workspace typecheck | **12/12 tasks passed** |
| Computer and server production builds | **Passed** |
| Workspace architecture checks | **Passed** |
| Runtime import-cycle audit | **120 source files; no cycles** |
| Changed-file formatting and `git diff --check` | **Passed** |

The route corpus exposed an error-precedence difference for malformed rich-message IDs. Those handlers now explicitly retain ID decoding before body parsing, with a permanent regression test.

The opt-in reaction fixture had a missing `sendDebounced` mock and obsolete `handoff_resume` assertions. The existing production implementation uses a priority `user` wake; the fixture now checks that unchanged behavior and transcript-projection scheduling. Production reaction behavior was not changed.

Added tests cover service adapter laziness/error identity, late-bound forwarding, non-mutating metadata/message mapping, route short-circuiting and validation order, schema parity, and real local TCP/HTTP screen-health probes. Existing source-layout checks were updated to inspect the extracted implementation modules rather than only the former monolithic files.

### Workspace-wide caveat

A fully uncached `bun run test --force` attempt fails in **three CLI setup-label assertions** (`Access`/`Owner` versus `Connection`/`Account`, and the stage-label list). The CLI is being changed separately in this working tree and was not edited as part of this refactor. A prior cached workspace run passed; it is **not** treated as proof that the current uncached full-workspace suite is green. Focused computer/server tests were subsequently rerun uncached and passed.

Live inference/provider authentication and a complete Linux graphical desktop session were not exercised against external accounts. QA used local browser tests, local health probes, mocks, and disposable PostgreSQL; no production database or live account state was modified.

## Reproduce

```sh
bun run typecheck
bun run check:architecture
bunx --no-install turbo run test --filter=@openteam/server --filter=@openteam/computer --force
bun run --filter @openteam/server --filter @openteam/computer build
```

For database fixtures, initialize a fresh database and apply `packages/db`'s schema first, then set `OPENTEAM_TEST_DATABASE_URL` and run each integration file separately. **Never point these fixtures at an existing database: some truncate tables.**

## Further opportunities outside this app scope

The inventory also found large shared-package implementations in `packages/messaging/src/agent-data.ts`, `index.ts`, `routines.ts`, and `asset-store.ts`, `packages/contracts/src/index.ts`, and product-core delivery/history modules. These were inspected as dependencies but not split in this pass. Prisma-generated model files were excluded from refactoring; changes belong in their generator/schema, not generated output.

## Follow-up validation

The [2026-09-05 simulator/runtime validation](computer-server-validation.md) adds native iOS Release/XCTest coverage, live Linux runtime checks, authenticated HTTP flows, offline/restart checks, a keyboard-layout fix, and the current remaining release gates. Its uncached workspace test run supersedes the earlier CLI-test caveat above.
