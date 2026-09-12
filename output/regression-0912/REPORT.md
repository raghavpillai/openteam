# Uncommitted refactor regression assessment — September 12, 2026

## Verdict

**Worth keeping. No blocking functional regression was found.** The changes successfully separate large runtime and service implementations while preserving the behavior exercised here. There is a reproducible, small HTTP-dispatch performance regression: history and send handlers take approximately **2–3 additional microseconds** with service work stubbed. Real PostgreSQL read workloads showed no statistically resolved slowdown in the paired measurements.

This is an assessment of the uncommitted changes relative to `2caa85e`; the full commit is recorded in `environment.json`. It is not a claim that every product workflow or release gate is green. Existing desktop and iOS bundle-size gates fail in both arms. No product source was changed during this audit, and nothing was committed or pushed.

## Comparison setup

- Baseline: a fresh `git archive HEAD`, at `2caa85e`.
- Candidate: the same archive overlaid with the existing uncommitted source, tests, docs, and lockfile. Previous output artifacts were excluded.
- Both copies use the same installed dependency trees, Bun 1.3.8, host, and shared-package implementations. The shared packages are unchanged by this diff. No dependency installation or upgrade was performed.
- Frozen copies: `/private/tmp/openteam-regression-0912-joqrj5pz/{baseline,candidate}`.
- PostgreSQL tests use a newly initialized local cluster. Each integration fixture has a fresh database cloned from an empty schema. Performance data uses a separate synthetic database with 1,000 bots, 100 groups, and a 10,000-message long-transcript fixture in addition to the ordinary fixture history.
- Database measurements alternate baseline/candidate order for 60 pairs after eight warm-up pairs. Computer measurements generally use 40 pairs after eight warm-ups. CPU-heavy build and benchmark jobs were not run concurrently with the measured workloads.
- HTTP microbenchmarks use three separate processes per arm, alternating process order, each with 1,000 warm-up requests and 30 batches of 500 requests per workload. They include request creation, the actual server handler, response creation, and body consumption; database, authentication-provider, event-stream, and asset-service boundaries are fixtures.
- Confidence intervals in `summary.json` are bootstrap intervals for the median paired latency difference. They describe these local samples, not production SLAs or fleet-level confidence.

## Functionality

| Check | Baseline | Candidate |
|---|---|---|
| Uncached workspace tests | 1,269 pass, 0 fail; 19/19 tasks | 1,284 pass, 0 fail; 19/19 tasks |
| Workspace typecheck | Not separately rerun | 12/12 tasks pass, uncached |
| Workspace build | 13/13 tasks pass | 13/13 tasks pass |
| Architecture checks | Not separately rerun | Pass |
| HTTP differential cases | Reference | 11,338 comparisons match |
| PostgreSQL A2A routing contract | Pass | Pass |
| PostgreSQL agent-file lifecycle | Pass | Pass |
| PostgreSQL plugin lifecycle | Pass | Pass |
| PostgreSQL reaction wake fixture | Old fixture fails; corrected fixture passes | Pass |
| Worker A2A integration fixture | Pass | Pass |
| Real headless Chromium smoke test | Seven checks pass | Seven checks pass |
| Persisted conversation blobs | Reference | All 4,801 records byte-identical |

The regular test count includes database-gated tests that return early without configuration. The five explicitly enabled database fixtures above supply that additional coverage; they must not be inferred from the 1,284 count alone. The worker A2A fixture uses a fake computer/turn stream, not a live model.

The HTTP comparison covers 100 discovered/added method-path targets, both required and disabled authentication, valid and invalid bodies, query validation, malformed and encoded IDs, internal-token checks, unauthorized sessions, API aliases, unknown routes, and method fall-through. It compares service calls and arguments, response status, body, headers, and request-body consumption. Variable `Server-Timing` values are excluded. This is a broad deterministic corpus, not exhaustive fuzzing; service effects are stubbed, with database behavior tested separately.

The real Chromium test uses an isolated browser profile and a local HTML fixture. Navigation, ARIA snapshots and element references, filling and clicking a form, page-scoped CDP, rejection of privileged CDP, PNG screenshots, and isolation between concurrent browser sessions all work in both implementations. This exercises the extracted Playwright driver with actual Chromium. It is not real-model computer-use validation.

The reaction fixture deserves particular attention because its assertions changed: the old fixture has no `sendDebounced` mock and still expects `handoff_resume`. I ran the corrected candidate fixture against **unchanged baseline production code**, and it passed. This supports the change being a fixture repair rather than hiding a production behavior change.

## Performance

### Real PostgreSQL service work

Medians in milliseconds; response objects were deeply equal before measurement. Timing measures service execution, not network or mobile rendering time.

| Workload | Baseline | Candidate | Change |
|---|---:|---:|---:|
| Bootstrap, 1,000 bots | 23.948 | 23.808 | −0.6% |
| Compatibility client snapshot, 14.9 MB JSON representation | 78.082 | 78.161 | +0.1% |
| History, 100 messages | 0.537 | 0.528 | −1.7% |
| Message context, 101 messages | 0.710 | 0.705 | −0.6% |
| Channel activity | 0.800 | 0.796 | −0.4% |
| Search, all categories | 10.905 | 10.853 | −0.5% |
| Search, messages | 2.485 | 2.495 | +0.4% |

All seven paired-difference confidence intervals include zero. These results support **no detectable service-level regression under this fixture**, rather than a speedup claim.

### Computer storage and compaction

| Workload | Baseline median | Candidate median |
|---|---:|---:|
| Digest 2,000 messages | 1.061 ms | 1.029 ms |
| Partition 2,000 messages for compaction | 3.064 ms | 2.981 ms |
| Publish 100 conversation envelopes | 0.755 ms | 0.725 ms |
| Read 1,000 transcript entries | 0.448 ms | 0.450 ms |
| Snapshot 250 unchanged agents / 510 files | 23.669 ms | 23.350 ms |
| Snapshot one dirty agent | 1.888 ms | 1.903 ms |

Outputs were compared on every paired run. Conversation blob records were also read directly from both SQLite files and compared byte for byte. Snapshot comparisons cover ordered content hashes and sizes.

An initial 200-operation key/value batch looked 19% slower. I did not dismiss it: a dedicated confirmation used 60 warm-up batches and 100 measured batches of 500 operations, repeated in three fresh processes with reversed import order. The slowdown did **not** reproduce. Candidate read medians were between −0.9% and +2.1% of baseline; writes between −0.5% and −1.8%; combined write/read pairs between −0.3% and −9.5%. The original observation should not be presented as an established regression, nor the repeat results as a promised speedup. Both sets of raw results are retained.

### HTTP dispatch overhead — a real, small regression

Medians over 90 batch samples per arm, in microseconds per request:

| Handler | Baseline | Candidate | Additional time |
|---|---:|---:|---:|
| Bootstrap | 7.08 | 7.18 | +0.10 µs |
| History | 8.42 | 10.54 | +2.13 µs / +25% |
| Send message | 10.13 | 12.91 | +2.77 µs / +27% |
| Unknown route | 6.50 | 7.62 | +1.11 µs / +17% |

This repeats across all three runs. The likely cause is the additional asynchronous route-module and per-route dispatch boundaries in `main.ts` and `routes/dispatch.ts`. The percentages describe a very small, stubbed workload. They do not mean real message delivery is 27% slower. The history overhead is approximately 0.4% of the measured database history service time before network latency.

I would not block this refactor on a few microseconds per request. If HTTP CPU cost becomes material at high request rates, avoid awaiting unmatched handlers or choose the domain before entering asynchronous dispatch. This audit did not modify that code.

## Build size and existing release failures

| Artifact | Baseline | Candidate | Difference |
|---|---:|---:|---:|
| Computer server JS | 1,923,926 B | 1,920,921 B | −3,005 B |
| API server JS | 10,216,675 B | 10,206,017 B | −10,658 B |
| Provider CLI JS | 785,606 B | 785,606 B | 0 B |
| iOS release Hermes | 4,659,557 B | 4,659,657 B | +100 B |
| iOS source-mapped Hermes | 3,801,044 B | 3,801,132 B | +88 B |

The mobile module count remains 2,201. The keyboard wrapper is a negligible bundle increase, but the exact release bundle has only 343 bytes of headroom under its existing 4,660,000-byte cap. The mapped bundle exceeds its 3,800,000-byte cap in **both** copies. Absolute bundle sizes can depend on build environment and paths; these are same-host, same-dependency measurements from the frozen copies, not a claim that older artifacts had these exact bytes.

The server gzip size grows by 452 bytes (about 0.016%) despite the raw JS reduction; computer gzip shrinks by 80 bytes. There is no material backend bundle-size penalty.

The desktop gates also fail identically in both copies:

- Renderer: 15,605,392 B versus a 15,582,000 B budget.
- Electron runtime: 2,327,253 B versus 2,300,000 B.
- Embedded CLI: 1,631,455 B versus 1,600,000 B.

These desktop failures predate the uncommitted diff. Keep them as separate release work; do not attribute them to the computer/server modularization.

## Code-quality assessment

The major boundaries are reasonable: compaction durability versus message rules, runtime lifecycle versus tools/events, agent handles versus records/recovery, browser transport versus cookies/origin state, and server routing versus domain services. Shared message projection and lazy error handling remove meaningful duplication. Public compatibility entry points remain, and the new tests cover validation ordering, error identity, laziness, forwarding, schema parity, and endpoint health.

Current source inventory changes from **62 to 120 production TypeScript files**, and **24,525 to 25,052 lines (+527, +2.1%)**. The largest file falls from 2,307 to 750 lines. This is a maintainability refactor, not a total-code reduction. The higher file count and forwarding helpers are a tradeoff; I would avoid further splitting solely to satisfy a line-count target.

The mobile change is one additional flex container inside `KeyboardAvoidingView`, which anchors the absolute composer to the resized content. The large JSX diff is mostly indentation. Its new source-structure test and production export pass. The earlier September 5 report contains native simulator evidence for the keyboard fix; that native XCTest/UI evidence was not regenerated in this audit.

Recommendation: retain the refactor and keyboard fix, keep their commits focused, and track the inherited size-gate failures separately. No blocking code-review defect was identified in the inspected changes or measured paths.

## Limits and reproduction

Not measured here: live inference-provider behavior, a real-model A → B → computer-use → A workflow, physical-device behavior, native iOS frame cadence or memory, APNs, a clean Linux container build, production traffic throughput, or production startup/memory consumption. Browser input was scripted and provider-dependent integration paths use fixtures. Tests passing do not close those acceptance gaps.

The first test attempt overlapped Prisma generation with typechecking and failed on competing writes in the disposable candidate copy. It was rerun after typechecking completed and passed uncached. Chromium needed `OPENTEAM_NODE_BINARY` set to the installed Node 24 executable in both arms; the hardcoded default discovery issue is shared by baseline and candidate.

Primary evidence files:

- `environment.json`, `summary.json`, `bundle-comparison.json`.
- `baseline-tests.log`, `candidate-tests.log`, `candidate-typecheck.log`, build and architecture logs.
- `database-tests.json` and per-fixture logs, including `baseline-reaction-corrected.log`.
- `route-comparison-disabled.json`, `route-comparison-required.json`, and full per-arm route results.
- `database-performance.json`, `computer-performance.json`, `kv-confirmation-*.json`, `route-perf-*.json`.
- Both browser smoke results and mobile/desktop budget logs.

Harness sources are alongside this report: `route-probe.ts`, `db-probe.ts`, `computer-probe.ts`, `kv-confirmation.ts`, and `browser-smoke.ts`. Their arguments name the frozen snapshot and output path explicitly. The source snapshots and disposable database cluster remain in the temporary audit directory for inspection; the cluster is stopped after the audit. No production database, user browser profile, or account was used.
