# Computer/server follow-up validation — 2026-09-05

## Result

**Thoroughly exercised, but not 100% release-green.** The functional checks below pass. Bundle-size gates, a clean Docker-image build, and physical-device/external-provider validation remain open.

The simulator caught a real mobile UI defect: the chat composer was positioned absolutely against `KeyboardAvoidingView`, so keyboard padding reduced the message list but left the composer underneath the keyboard. `apps/mobile/app/chat/[channelId].tsx` now anchors the overlay inside a flex content view resized by that padding. The substantial-looking JSX diff is mostly indentation around that wrapper. Added `apps/mobile/test/keyboard-layout.test.ts` and verified the fix in a signed native Release build, including a native assertion that Send is above the keyboard.

- [Before: composer hidden by keyboard](../output/validation-0905/screenshots/keyboard-obscured-before.png)
- [After: composer and Send above keyboard](../output/validation-0905/screenshots/composer-above-keyboard.png)
- [iOS viewing the real Linux desktop](../output/validation-0905/screenshots/native-linux-computer.png)
- [Evidence summary](../output/validation-0905/evidence/summary.json)

## Passed checks

| Check | Verified result |
| --- | --- |
| `bun run test --force` | **1,284 passed, zero failed; all 19 tasks rerun uncached**. The earlier CLI assertion failures are no longer present in this checkout. |
| `bun run typecheck` | **12/12 tasks passed** |
| `bun run build` | **13/13 tasks passed**, including desktop and iOS export |
| `bun run check:architecture` | Passed workspace layering, enum parity, mobile boundary, and duplication checks |
| Mobile tests/native config | **147 passed**; 23 unique Expo packages and 24 unique pods |
| Native application build | Xcode **26.6**, iOS **26.5**, iPhone **17 Pro** simulator, **Release**, correctly ad-hoc signed; not Expo Go |
| Native XCTest scenarios | **6 meaningful end-to-end scenarios passed**, described below |
| PostgreSQL-backed server integration fixtures | **4 passed**, executed separately against a fresh test database |
| Authentication end-to-end script | Owner updates, username/password login, revocation, and disabled public signup/password-change routes passed |
| Linux computer | Real shell command exited **0**; real Chromium navigation, ARIA snapshots, page-scoped CDP, and turn cancellation passed |
| Screen service | Graphical startup, 1280×800 PNG capture, Chromium launch, takeover/release, and pause/resume passed |
| HTTP/data plumbing | SSE emitted events; replayed message IDs were deduplicated; uploaded/downloaded PNG bytes matched; message attachments accepted |
| Authenticated plugin HTTP lifecycle | Install, connect, grant, policy update, and uninstall passed using the bundled utility fixture |
| Restart persistence | Message history and replay idempotency survived. A repeated simultaneous restart recovered in **1,723 ms**, preserved an authenticated session, and was followed by a successful authenticated iOS message round trip. |
| Artifact identity | Computer/server/worker bundles running in Linux matched the current local build **SHA-256 hashes** |
| Formatting | Changed mobile files pass Biome; `git diff --check` passes |

Native scenarios:

1. Send from iOS → real server/worker → Pi runtime → real Linux Shell → SendToUser → visible iOS reply; assert keyboard/composer geometry.
2. Create a Bot, send a message, create a two-Bot group, send a group message, search for the group, and open the real Linux computer view.
3. Stop the test server, cold-launch from cached state, queue a message offline, relaunch, and verify the queued message remains.
4. Restart the test server and verify the offline message is delivered and reconciled.
5. Switch the test server to required authentication, sign in through the native UI, relaunch, and verify the Keychain-backed session survives.
6. Restart the backend services and verify the authenticated iOS client can still send and receive.

Screenshots are in [`output/validation-0905/screenshots`](../output/validation-0905/screenshots). The successful native test sources and bounded machine-readable evidence are in [`output/validation-0905/evidence`](../output/validation-0905/evidence). Full transient logs and `.xcresult` bundles are under `/tmp/openbot-validation-0905`.

Exploratory test attempts needed correct simulator signing, case-insensitive matching of capitalized button labels, and paced name entry with exact-value assertions. The six-scenario count refers to final verified runs, not those exploratory attempts. An initial simultaneous-restart check exceeded a 20-second readiness window; data remained intact. The repeat used the normal health-check window and passed as measured above, not a guaranteed startup-time SLA.

## Remaining failures and limits

### Bundle-size gates are still red

Budgets were **not raised** to make the checks pass.

| Measurement | Observed | Budget | Over |
| --- | ---: | ---: | ---: |
| iOS source-mapped Hermes bundle | 3,801,104 B | 3,800,000 B | 1,104 B |
| Desktop renderer | 15,605,447 B | 15,582,000 B | 23,447 B |
| Electron runtime | 2,311,413 B | 2,300,000 B | 11,413 B |
| Embedded `openteam-cli.js` | 1,621,027 B | 1,600,000 B | 21,027 B |

The iOS mapped budget was already exceeded before the keyboard fix (3,801,036 B). The exact iOS export is 4,659,629 B, below its 4,660,000 B cap but with very little headroom.

### Clean container packaging was not completed

A fresh Docker Compose image build exhausted the existing Colima VM's 40 GB Docker disk. Linux dependency installation and server/worker compilation completed, but a full clean image build did not. It must be rerun after sufficient Docker disk space is available.

For functional runtime tests, the freshly built bundles were mounted read-only into version-matched existing runtime images. The Pi dependency was verified as **0.84.3**, and the running bundles were hash-checked against the current checkout. This validates the refactored runtime code, not a completed clean container-packaging pipeline.

### No claims about external services or real-device-only capabilities

Model responses came from a deterministic local OpenAI-compatible fixture. Shell execution, browser operations, worker queues, persistence, HTTP streaming, and native UI interactions were real. This does **not** validate a paid/live inference provider, live OAuth renewal, physical host bridges, APNs delivery, physical camera/microphone/haptics, or distribution signing. Those require separate checks with the relevant accounts and devices.

## Environment incident and cleanup

Test application data used a separate Docker project and fresh PostgreSQL databases. No production database was used for destructive fixtures.

The clean-image build's disk pressure interrupted the two pre-existing local PostgreSQL containers. The build was stopped, only its newly created intermediate images/build containers were removed, and the databases were brought back to their prior running state. The primary OpenTeam server was restarted after verifying zero Bots/active runs, restoring its health. The legacy QA database and canonical legacy QA endpoint also recovered.

An older auxiliary required-auth QA gateway still returned 503. Its shared legacy database had an active run, and no pre-task HTTP-health baseline was available for that gateway, so it was **not** restarted or represented as validated. The primary OpenTeam server/computer/PostgreSQL health checks are green.

Subsequent test data lived in project-scoped tmpfs volumes held across restart tests by a keeper container. The disposable test stack/volumes and dedicated simulator are cleaned up after evidence capture. Existing application images, unrelated caches, user simulator devices, and the active legacy run are left alone.

## Reproduce the ordinary checks

```sh
bun run typecheck
bun run test --force
bun run build
bun run check:architecture
bun run --filter @openteam/mobile performance
bun scripts/performance/check-desktop-budgets.ts
```

The last two commands currently fail on the budgets listed above. Database fixtures must be run separately against a fresh disposable database; some truncate tables. Check Docker VM free space before attempting a clean multi-stage image build.

## Coverage clarification — 2026-09-06

An audit of the actual test bodies and saved logs distinguishes the following:

| Workflow | What the saved evidence proves | What it does not prove |
| --- | --- | --- |
| A2A | The separately enabled server/PostgreSQL contract fixture exercised `SendToAgent` routing, self/missing-target errors, priority handling, group membership restrictions, mirrors, and group posting limits. | A real-model A → B → A exchange, or the complete model/runtime/worker A2A path. The computer in this fixture is fake. |
| Group chats | The native iOS scenario created a two-Bot group, sent `@all`, observed a group reply, and searched for the group against the real server/worker stack. | Autonomous collaboration by real inference models. Responses were scripted; group replies are not evidence of bot-to-bot delegation. |
| Computer execution | Real Linux Shell, real Chromium navigation/snapshots/page-scoped CDP, screen frames, takeover/pause, cancellation, and iOS computer viewing worked. | A real Grok model deciding graphical actions, or the complete parent → Task → computerUse worker → result loop. Browser turns were submitted directly and tool choices were scripted. |
| Grok | No live Grok/xAI inference was used in this validation. | Grok tool selection, visual reasoning, provider compatibility, and autonomous computer-task completion remain unverified. |

The workspace pass count must not be read as live integration coverage. `apps/worker/test/a2a-live.integration.test.ts` returns immediately when `OPENTEAM_TEST_DATABASE_URL` is absent; it was not one of the four explicitly database-enabled fixtures. Even when enabled, that test uses a fake computer/turn stream. Its name contains “live,” but it is not a live-model test.

The missing acceptance scenario is: a real-model Bot receives a group task, sends an A2A request to a peer, the peer delegates a bounded task to a Grok-backed computer-use worker on an isolated test desktop, and a verifiable result returns through A2A to the original group. Verify both recipients/transcript mirrors and absence of duplicate/cross-channel delivery; separately exercise permissions, human takeover, cancellation, and restart. Record the actual provider/model and tool events. This scenario has **not** been run.
