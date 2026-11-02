# Browser network implementation validation

Validated November 1–2, 2026 on `feat/connected-device-browser-network`. This is a local implementation, not a deployment or signed desktop release.

## Chaos engineering and hardening — November 2, 2026

Fault injection reproduced three failure classes before the fixes:

- **Unbounded route application:** a provider or broker could renew leases without acknowledging its route forever. Each peer now gets six seconds from its first grant to acknowledge the epoch; renewals do not extend that deadline. Provider removal enables ranked fallback; broker removal enables reconnect. Saved priorities/revisions are retained.
- **Reconnect amplification:** opening a socket reset backoff, including immediately closed connections. A briefly valid grant also reset it too early. Backoff now survives short-lived connections and resets only on a valid lease after a full six-second connected interval. New healthy routes remain immediately usable.
- **Wall-clock sensitivity:** a backward clock correction could strand stream admission at its rate limit, and a forward jump could bypass the retry throttle. Both limits now use monotonic time. Lease timing already did so.

The before-fix failures and after-fix logs are retained locally under `output/browser-network-chaos/`. The reproducible service tests cover missing provider/broker acknowledgments, database outages, single-destination DNS/dial refusal without source hopping or request replay, concurrent edits, enrollment revocation, disconnect/reconnect, broker replacement and clock jumps. SDK tests also cover a transport throwing during a write, callback completion, stream/window limits and recovery after a backward clock jump.

The eight focused service cases (including all 192 seeded operations) and ten SDK checks also pass inside the Linux computer container on the pinned **Bun 1.4.2** runtime. Logs: `pinned-linux-chaos.log` and `pinned-linux-sdk.log`. The local macOS runner remains Bun 1.3.8. Repeated cold startup exposed a separate fixture race: PostgreSQL's temporary Unix-socket bootstrap server could satisfy `pg_isready` before its application TCP listener existed. The harness now probes `127.0.0.1` explicitly before schema setup.

**192 seeded fault operations passed**: seeds `1`, `42`, `24301`, 64 operations each. Every quiescent step checks route recovery, preference/revision invariants and successful routing; remote round trips check exact bytes. These seeds reproduce fault choices, not identical wall-clock timings or TCP scheduling. Full guarded regression results: **382 server tests pass** (153 skipped), **711 desktop/shared tests pass** (one skipped), **three computer diagnostic/worker tests pass**, and **32 desktop UI assertions pass**. Desktop/server/computer/SDK typechecks, production builds and architecture checks pass. The inherited bundle-budget failures documented below remain outside this hardening change. No native iOS UI code or wire contract changes in this round; the previous native integration results remain separately recorded below.

**All 49 production-image checks passed on the final runtime images**, across 13 phases. The selected provider's outbound `eth0` queue used 80 ms delay, 20 ms jitter, seeded 2% loss; kernel counters recorded **two dropped packets**. All eight fault-phase uploads (four per browser, 64 KiB each) arrived once with exact hashes. Relay freeze expired browser leases and failed closed; both-provider freeze selected the ranked server; clearing each fault restored both browsers with persisted preferences. Normal restart, worker crash, native transfer, address-policy and sign-out checks also passed. Frozen-provider fallback took **4656 ms**, including test startup and both browser navigations. The byte-checked 256 MiB transfer took **4955 ms**; these controlled VM timings are not WAN performance promises.

Final evidence is under `output/browser-network-chaos/linux-verified/` (including `result.json`, `netem-result.log` and image identities), with the combined log in `linux-verified-run.log`. Runtime computer image: `5895bdde7add77ca68243ab42de3a05313250bf67d650453a50cb7d284ddcde3`; server: `65aaa8bd281325d1e8c5c44963bdb48024ed885a40cd5b05d810bb9e5a4ad540`. A preceding exploratory run also passed 49 checks; it is not the final-image evidence. The failed TCP-readiness attempt is retained for transparency. The final runner removed all fixture containers/networks/volumes, and the dedicated Colima VM/data were deleted afterward.

Repeat the focused suite with `bun run test:browser-network:chaos`. Reproduce a longer chosen sequence with:

```sh
OPENTEAM_NETWORK_CHAOS_SEED=24301 OPENTEAM_NETWORK_CHAOS_STEPS=64 bun run test:browser-network:chaos
```

The production Linux runner accepts `--chaos` in addition to the normal 43 checks. It adds 80 ms delay / 20 ms jitter / seeded 2% loss to the selected device's network namespace, verifies byte-exact single-delivery uploads from both actual browsers, checks recovery after clearing the fault, freezes the relay to check lease expiry and fail-closed behavior, and freezes both providers to check server fallback and stable return. It requires an explicit disposable Docker context and records the actual kernel drop counters; packet-loss validation must observe at least one dropped packet. The helper tooling has NET_ADMIN only inside the fixture device's namespace, and the runner cleans its named resources in `finally`.

```sh
colima start openteam-network-chaos --activate=false --ssh-config=false --cpu 4 --memory 7 --disk 22 --mount none
OPENTEAM_TEST_DOCKER_CONTEXT=colima-openteam-network-chaos OPENTEAM_TEST_OUTPUT_DIR=output/browser-network-chaos/linux bun run test:browser-network:linux --chaos
colima delete --force --data openteam-network-chaos
```

Physical Mac lid/Wi-Fi/VPN, IPv6-only Internet, signed installers and a long WAN soak remain release-environment coverage. Controlled kernel faults do not replace those checks.

## Integration with current main — November 2, 2026

Merged `origin/main` at `6e6be7e2cf4a182af8d1002c768d84318da22fdb` and resolved all eleven conflicting files. Both sides' package exports, computer install CLI, shutdown recording, desktop enrollment/Messages support, server settings and fixture routes are retained. Browser-network deep links now use the shared settings-anchor contract and still open Server; model links retain main's separate Model page.

iOS has one Server entry containing browser priorities and the existing server sections. Native reorder handles stay enabled; Manage devices and Updates navigate through the enclosing settings path so editing does not suppress navigation. The existing updates UI test now scrolls to offscreen controls and exercises Manage devices/back before the update flow.

Merged-tree validation:

- **374 server tests pass**, 153 guarded integrations skipped; **707 desktop/shared tests pass**, one existing integration skipped; **198 Swift core tests pass**; **three computer network tests pass**. The explicit browser-network deep-link panel assertion also passes.
- **32 desktop UI assertions pass**. Both native iOS tests pass together on an isolated iPhone Air / iOS 26.5 simulator: ranking, privacy, quality and fallback; then Manage devices, update confirmation, busy-bot refusal and server restart recovery. The native build uses **Xcode 27.1**, required by current main's fold-layout API; the default Xcode 26.6 cannot compile that API.
- **43 freshly rebuilt production-image Linux checks pass**, including real browser/device routing and DNS, both diagnostics, transfers, the one-minute soak, ranked failover/stable return, both service restarts, worker crash, frozen provider and sign-out. Frozen-provider fallback measured **4421 ms**, including test startup and two browser navigations; this remains a controlled VM measurement. The 256 MiB TLS transfer validated every byte in **1397 ms**.
- The Linux harness now matches main's computer bootstrap capabilities and runner UID **1000** and bounds the computer container to **3 GiB** inside the disposable VM. The initial run exposed the old harness's incompatible mount permissions; the corrected complete run passed. Per-desktop memory-helper coverage belongs to main's separate memory harness; it is not enabled by this network harness.
- Frozen lockfile installation, desktop/server/computer/SDK typechecks, all three production builds, architecture boundaries and `git diff --check origin/main` pass.

The desktop **bundle-budget gate does not pass** after integrating main. A separate clean checkout of the same main commit reproduces the **same ten failing budgets**; existing limits were not increased. Main versus merged: renderer **16,955,998 → 16,971,075 bytes**, signed-in startup **1,691,093 → 1,691,635 bytes**, Electron runtime **2,515,454 → 2,594,812 bytes**. The dedicated network settings closure is **16,298 bytes**, within its 25,000-byte ceiling. The earlier passing budget results below apply to the earlier base, not this merged revision. Both builds used the same local Bun 1.3.8 runner; Linux used the pinned Bun 1.4.2.

Evidence remains local under `output/browser-network-merge/`: `linux-final/result.json`, phase logs/image identities, `IntegratedUI.xcresult`, `ios-summary.json`, suite/build logs and separate main/merged bundle measurements. The temporary baseline checkout, dedicated simulator, Colima VM/data and test containers/networks/volumes were removed; test result bundles remain available. Physical WAN/lid/VPN and signed-installer limitations below still apply.

## Faster failover and active-exit quality — November 2, 2026

Implemented and validated: six-second monotonic leases renewed every two seconds (previously 15/five); event-driven sleep/disconnect fallback; warm fallback channels; acknowledgment-gated availability with immediate broker wakeup; at most 64 unsent opens held for at most two seconds during transition; cancellation/timeout without replay. Pending old challenges are discarded on invalidation. In-flight data before a new acknowledgment is dropped while keeping healthy control channels connected. Existing transfers still close on epoch changes; this is not seamless TCP/WebSocket migration. The 30-second stable-return delay remains.

Server settings on desktop and native iOS now include a manual Connection test: median HTTP latency plus estimated download/upload Mbps through the active browser exit. Fixed Cloudflare HTTPS endpoints, verified TLS/SNI, device-side DNS, 1 MiB down/256 KiB up, byte caps, 20-second total deadline, one-minute caching, coalescing, route/source checks and late-socket cleanup. It never automatically measures throughput, modifies rankings or replays website work. Results clear when the displayed route changes. These small samples estimate effective single-connection speed rather than maximum Internet bandwidth.

Measured results:

- Ten local authenticated tunnel disconnects, with 700 ms between iterations: median **18 ms**, slowest/p95 sample **20 ms**, through the next usable warm exit. A separate rapid burst run had an approximately 1.2-second outlier; these measurements are not WAN or physical-sleep guarantees.
- In the final production Linux run, Docker-pause froze the provider without closing its socket. Both managed browsers navigated through the next ranked exit after **5874 ms**, including test startup and browser navigation. Saved priority and revision stayed unchanged. The resumed provider reclaimed its rank after 30 stable seconds.
- The controlled 256 MiB TLS transfer validated every byte. A one-minute two-browser soak completed across the shorter lease renewals.

Final checks: **318 server tests pass** (108 unrelated integrations skipped), **622 desktop/shared tests pass** (one existing integration skipped), **three computer tests pass** including 30+ Node TLS assertions for each diagnostic, **135 Swift core tests pass**, **32 desktop UI assertions pass**, and the native iOS ranking/privacy/quality/fallback test passes. Coverage includes delayed/missing acknowledgment, bounded/cancelled/expired unsent opens, no premature dialing/replay, old-epoch grants, stale in-flight frames, repeated disconnect timing, body/encoding/redirect/error limits, coalescing/cache, offline refusal and source changes. Desktop/server/computer/SDK typechecks, desktop production build, bundle budgets, architecture checks and diff whitespace checks pass.

**43 production-image Linux checks pass** across real authenticated enrollment/consent, two managed Chromium instances, native file uploads/downloads, HTTP/TLS/WS/WSS, workers/subresources, DNS/private-address/UDP restrictions, 256 MiB transfer, one-minute soak, ranking, both service restarts, worker crash, frozen provider, stable return and sign-out. Both IP and quality diagnostics were observed leaving device A, and again device B after switching/restart. The computer container had no direct target path or target DNS. The fixed public diagnostic hostnames were mapped only by the isolated device-side DNS fixture; a test-only Node wrapper supplied the isolated CA while normal TLS verification remained enabled. The final runtime images include both stale-grant and stale-frame fixes. Runtime: Bun 1.4.2, Node 20.19.2, Linux arm64 in a disposable Colima VM.

Evidence: `output/browser-network-quality-linux-final/result.json`, per-phase logs and image identities; `output/browser-network-compact/quality-performance-summary.json` and test/build logs. Updated full-app UI fixture recordings: [desktop MP4](../../../output/browser-network-compact/desktop-exit-quality.mp4), [iOS MP4](../../../output/browser-network-compact/ios-exit-quality.mp4). Recorded devices, IPs and rates are illustrative fixtures; the Linux routing tests above use real network traffic through the production transport. Live vendor compatibility checks also passed from the development host and are explicitly separate from exit-speed measurements.

Physical Mac lid/WAN/VPN permutations and a long WAN soak remain release-environment coverage. The settings refresh interval is separate from network failover timing.

## Status styling refinement — November 2, 2026

Replaced the active-source checkmark with a subtle **In use** pill in both clients. Inactive providers retain Working/Not working. The desktop app shows **(current)** next to its enrolled machine by matching its local enrollment ID to the roster, independently of the active source. iOS manages desktop providers and does not identify one of those computers as the current iPhone.

The updated desktop interaction suite passes **27 assertions**, including the enrolled local marker and active status badge. Desktop typecheck, production build and bundle budgets pass. The native iOS build and complete ranking/privacy/fallback UI test pass on an isolated iPhone Air simulator. Updated full-app fixture recordings: [desktop MP4](../../../output/browser-network-compact/desktop-status-refinement.mp4), [iOS MP4](../../../output/browser-network-compact/ios-status-refinement.mp4). Both layouts were visually inspected. Fixture devices/IPs are illustrative; transport behavior is unchanged by this styling revision.

## Current compact Server settings and exit diagnostics

The latest revision moves browser networking into **Settings → Server** on desktop and iOS. Desktop uses the existing `@dnd-kit/react` sortable library with pointer and keyboard sensors; iOS retains native SwiftUI reorder handles. Compact rows show Working/Not working and an active checkmark. Explanatory subtitles and connection cards are removed. Exit IP and approximate city/country use independent click/tap-to-reveal values, hidden by default and again on source changes/backgrounding. The desktop reuses the endpoint privacy component.

Validation on November 1, 2026:

- **26 desktop UI assertions passed**: automatic provider registration, pointer reordering, keyboard movement and Escape cancellation, draft/apply semantics, computer/server fallback, no duplicates, concurrent edit rejection, per-device status, independent privacy controls, hidden accessibility values, source-change privacy reset, failed diagnostics clearing stale IPs and narrow layout.
- **Native iOS interaction test passed** on an isolated iPhone Air simulator (iOS 26.5): Server navigation, hidden/revealed IP/location accessibility values, native drag handles, conditional Apply, server/computer fallback, privacy reset, Not working status and Discard. An initial hit-area/accessibility issue was corrected: the entire native privacy row now responds to taps and explicitly retains its button trait. The passing recording comes from the corrected build.
- **313 server tests passed**, 108 unrelated integration tests skipped. Includes real Chromium HTTP/HTTPS, WS/WSS, workers, uploads/downloads and the production Node worker's new diagnostic command. A controlled TLS endpoint with a test CA is reachable only through the enrolled device's real multiplexed tunnel; its result passes source/epoch validation. Wrong sources, stale epochs, mid-check route changes and absent workers reject diagnostics.
- **621 desktop/shared tests passed**, one pre-existing integration test skipped; **134 Swift core tests passed**.
- **Two computer tests passed**, including a Node TLS diagnostic runner with 30+ assertions: fixed destination/SNI, coalescing/cache, source changes, offline refusal without dialing, redirect/error/content-type/body-limit/malformed-IP refusal, failure caching, stale-result rejection, total timeout and destruction of a late socket. Parent-pipe shutdown and credential output redaction also pass.
- A **live provider compatibility check passed** against ipwho.is with normal TLS verification. The public address was not logged. This checks provider response compatibility from the development host; controlled end-to-end tests separately verify device routing.
- Desktop/server/computer typechecks, desktop production build, bundle budgets and architecture boundaries passed. Server responses inherit `Cache-Control: no-store`.

Current full-app recordings: [desktop MP4](../../../output/browser-network-compact/desktop-full-app.mp4), [native iOS MP4](../../../output/browser-network-compact/ios-full-app.mp4). They show the actual OpenTeam renderer/native application without test captions or side panels. Device events, addresses and locations in these UI recordings are inert fixtures using documentation IPs; real routing is validated separately above. Logs, screenshots and the passing native result bundle are in `output/browser-network-compact/`.

The disposable Linux production-image validation below remains valid for the network transport baseline. This compact UI/diagnostic revision was tested locally with real Node transport and native iOS; it was not rerun in Colima. Physical Mac sleep/VPN/WAN and signed-installer checks remain release-environment coverage.

## Earlier full-app interface redesign (superseded layout)


The subsequent interface update gives desktop Browser network its own lazily loaded Settings tab and command-palette/deep-link destination. Desktop and native iOS now use a compact active-connection card, device icons, clear priority rows and secondary connection details. iOS uses native drag handles and accessibility move actions; Apply lives in the navigation bar.

The desktop's 18 existing UI checks, 621 desktop/shared tests (one skipped), native iOS interaction test, desktop typecheck/build, architecture checks and bundle budgets passed. The full desktop renderer was also exercised from the workspace through Account → Settings → Browser network, local sharing, drag/reorder, Apply and computer/server fallback, with zero page errors. The fixture's capabilities and read receipts now use the complete client contract so it can support both native and full desktop renderers.

`output/browser-network-polish/desktop-full-app.mp4` and `ios-full-app.mp4` show the actual applications with no added captions, panels or overlays. Device events remain inert UI fixtures. The dedicated network stylesheet loads with its settings tab; existing global startup limits were preserved and a bounded lazy-entry budget was added. No networking/runtime policy changes were made in this visual update.

## Always-ranked desktop and native iOS update

Validated November 1, 2026 in the same worktree. Browser networking now always uses ranked settings. A locally approved provider's first validated lease automatically adds it to the saved priority pool. The desktop mode selector and separate Add step have been removed. Native iOS Settings → Browser network manages the same list; the iPhone is not a provider.

- **312 server tests passed**, 108 skipped. The 20 network tests include new automatic registration, concurrent provider additions, no duplicate on reconnect, preserving an elevated server, and rejecting drafts made stale by an automatic pool addition. The actual Chromium/Node relay scenario also passed again, including HTTP/HTTPS, resources, workers, uploads/downloads, WS/WSS and a byte-checked 256 MiB TLS response.
- **621 desktop/shared tests passed**, one skipped. **18 browser-driven UI assertions passed**: always-visible priority, local opt-in automatically adding the computer without Apply, native desktop drag/drop, accessible controls, draft-versus-Apply behavior, computer/server fallback, preserving saved offline entries, no duplicates, cross-client stale-edit protection, narrow layout and no browser errors.
- **132 iOS core tests passed**, including four new network contract/status tests. The native iOS 26.5 iPhone Air simulator UI test passed, exercising actual native drag handles, arrow controls, conditional Apply, computer/server fallback, all computers offline, discarding drafts and the desktop sharing instructions. Device availability events in these UI tests use inert fixtures, not live traffic.
- A new isolated local PostgreSQL database passed **19 persistence/concurrency expectations**: ranked defaults, durable source ordering, conditional updates, legacy pinned-device migration, legacy server-first migration, idempotence and simultaneous migration reads. The database was stopped and deleted after the run.
- Native app/test build, desktop production build and budgets, desktop/server type checks and architecture checks passed. Logs and current MP4 recordings are under `output/browser-network-always-ranked/`.

The 38 production-image Linux checks below describe the preceding ranked implementation. The always-ranked update reran actual Chromium routing on macOS plus the scoped server, PostgreSQL and native iOS checks above; a fresh Linux VM run was not repeated for this UI/policy update. The Linux runner's expectations have been updated for universal ranked fallback and automatic provider registration.

## Ranked connection validation update

The subsequent ranked-source implementation passed **38 Linux production-image end-to-end checks** on November 1 local time (November 2 UTC). The server is a normal, required entry in the ordered list and can be dragged above, below or between computers. Manual mode retains its previous pause-without-fallback behavior. Ranked mode follows only the saved order; returning preferred devices need 30 continuous seconds of eligibility before preempting a healthy fallback.

- **310 server tests passed**, 108 skipped, on macOS; includes seven new ranked routing regressions. All **seven ranked regressions also passed on Linux/Bun 1.4.2**, including silent-socket lease expiry, stable return, revocation, conditional updates, server precedence and invalid/unapproved entries.
- **608 desktop/shared tests passed**, one skipped. **15 browser-driven settings checks passed**, including native drag/drop of the server row, accessible arrow controls, draft-versus-Apply behavior, persisted order, active-provider status, fallback and narrow layouts.
- A fresh isolated PostgreSQL database passed the settings persistence/CAS test with the new `sourceOrder` column, including ranked order surviving a new store instance and stale updates being rejected. The production-image schema setup and real enrollment checks also passed.
- Server/computer/desktop/SDK/client and harness type checks, desktop production build, architecture checks, diff checks and desktop bundle budgets passed. The three production Linux images rebuilt successfully.

The **38** Linux checks comprise 21 existing browser/network cases, **12** ranking-specific cases, server restart, computer restart, and three final session-revocation cases. They use the real authenticated application server, two enrolled Linux clients running production desktop controllers, and two managed headed Chromium browsers. They prove actual device A → device B → server egress, server-first and server-middle ordering, transfer interruption at switches, preference revision stability during fallback, 30-second return to the preferred device, and saved rankings surviving both server and computer restarts. Signing out revokes device sessions and their old sockets; with ranked mode enabled, the explicitly listed server then provides fallback.

The production owner API also rejected an attempt to stage an unapproved computer through manual-mode settings, closing a validation bypass before the final run. Individual website failures do not trigger route hopping or request replay. A 256 MiB TLS transfer checked every byte, and a 60-second two-browser soak completed 542 requests on the final run. These are isolated VM results, not WAN throughput or availability promises.

Latest logs, image identities and per-phase results are under `output/browser-network-ranking/`; settings screenshots are under `output/browser-network-ui/`. The dedicated `openteam-network-ranking-test` Colima profile and its data were deleted after testing. Packaged desktop installers, physical WAN/VPN and IPv6-only release checks remain as listed below.

The sections below retain the earlier manual-routing baseline, including its full 144-file computer regression run. They do not replace the ranked-mode results above.

## Results

- Server suite on Linux/Bun 1.4.2: **303 passed**, 108 skipped. Includes real-browser networking, route authority, destination policy, stream limits, reconnect, revocation, and lease-expiry coverage.
- Desktop and shared client/contracts/plugin SDK suites on macOS: **608 passed**, one database-gated test skipped in that run.
- Computer tests on Linux/Bun 1.4.2: **640 passed**, 34 skipped across **144 isolated test-file processes**. This includes eight real X11 input checks and the Node worker's parent-lifetime test. The earlier macOS run passed 628 with 50 skipped.
- Isolated PostgreSQL integration: **four passed**, covering schema deployment, persisted network selection and conditional updates, machine authentication, and real desktop enrollment/file/command reconnect and revocation.
- Browser-driven settings checks: **eight passed**, covering local opt-in, disabled unapproved devices, explicit Apply, local revoke without fallback, explicit server selection, JavaScript errors, and narrow layouts.
- Production-image Linux end-to-end checks: **26 passed**, including authenticated enrollment, two managed graphical Chromium browsers, real device-side DNS/TCP source proof, native transfers, route changes and full process/container recovery. The separate packaged-computer capability check also passed.
- Focused Linux protocol, multiplexing, consent and Node worker tests: **17 passed**.
- Desktop, computer, server, shared network code and client type checks passed. Server/computer/desktop production builds, architecture checks, diff checks and desktop bundle budgets passed. An installer/ASAR release was not built.

Tests requiring external providers or broader database fixtures remain skipped by their existing guards. Four targeted database tests passed against disposable PostgreSQL 17 databases on both macOS and Linux, never the owner's application database. The full computer suite ran as the unprivileged runner user with a writable private home; Linux graphical guards were enabled where their binaries were available.

## Linux production-image validation

A dedicated Colima profile ran Ubuntu 24.04.4 ARM64 with a Linux 6.8 kernel, four CPUs and seven GiB RAM. The repository's production computer, server and schema-setup Dockerfiles all built successfully with pinned Bun **1.4.2**. The computer runtime was Debian 13, Node **20.19.2**, and Chromium **156.0.8078.73**. Image identities and logs are retained under `output/browser-network-linux/`.

The reproducible harness is `scripts/test-browser-network-linux.ts`, also exposed as `bun run test:browser-network:linux`. It publishes no host ports, mounts no checkout or host credentials, uses randomly generated test-only owner/control credentials, and provisions its own database and shared volumes. It does not change Docker's active context. Its default cleanup removed all of its containers, networks and volumes on the successful run. After the remaining regression checks, the temporary Colima profile and its container data were deleted; the original Docker Desktop context remained selected.

The real authenticated application server enrolled two Node/Linux clients using the actual desktop enrollment and local-consent controllers. Two headed browsers were created by the production computer service's ScreenBroker as UID 1001. The test origin and DNS service lived on a separate Docker `--internal` network. Its synthetic globally routable IPv4 addresses exercise the normal public-address policy unchanged; they are not routed onto the Internet. The computer could neither resolve the reserved test hostname nor connect directly to its address. The origin observed browser traffic from device A (`11.77.0.11`) and then device B (`11.77.0.12`) after explicit selection; the DNS fixture also observed device-side queries. This proves routing across Linux network namespaces, not a physical residential public-IP change.

The isolated origin's TLS certificate was explicitly trusted in the temporary browser NSS store; production browser flags and TLS verification were retained. The only driver accommodation grants Chromium access to Playwright's temporary download directory because the test driver runs as root and Chromium runs as the runner user.

All four phases passed: **21** initial checks, **one** server-restart check, **one** computer-restart check, and **three** final/sign-out checks. Coverage includes:

- Real owner HTTP and computer WebSocket authentication; enrolled devices initially have no sharing consent and cannot be selected.
- Both managed bot browsers: HTTP/TLS pages, scripts, styles, images, iframe, fetch, dedicated/service workers, and WS/WSS through the selected device.
- Native file-input upload with SHA-256 equality, native browser download with byte equality, and a **256 MiB TLS stream** checking every byte. The final transfer took about 1.4 seconds inside the VM; this is not a WAN throughput estimate.
- Loopback bypass, metadata, private server addresses, disallowed ports and mixed private/public DNS answers rejected; no direct WebRTC UDP candidates.
- Device selection changes, local Stop sharing, enrollment disconnect, suspend/resume, and server-side machine disable interrupt an in-flight transfer. Offline selection stays sticky and never falls back; explicit server selection restores computer-side routing. Ordinary non-browser fetch remains unaffected.
- Re-enrollment with saved consent, worker SIGKILL and supervision recovery, full server restart, and full computer-container restart restore the same selected device and both managed browsers.
- A **60-second two-browser soak**, 286 iterations / 572 requests, spans repeated lease renewals. Real owner sign-out revokes the enrolled session, its active route, and the owner token without browser fallback.

The VM run found and fixed two failures that local testing had missed. A replacement computer restarts stream IDs at 1, while the surviving device transport previously retained the old incoming-ID watermark. Route fencing now resets that watermark, while preserving monotonic outgoing IDs and guarding against late old dial callbacks removing a new dial. A regression reproduces the original failure and passes with the fix. Full computer restart also exposed a stale X11 socket being mistaken for a ready display; startup now probes the live X server before launching desktop clients. The final production-image run passed both recovery scenarios.

An exploratory invocation enabling every repository database test was not clean: it encountered plugin lifecycle expectations and missing development-fixture dependencies in the production-filtered regression image. It is not counted as a passing full database suite. The scoped database/enrollment checks, complete guarded server suite, and all 144 isolated computer files above passed after preparing their required test environment.

## Network scenarios exercised

Real installed Chromium used the production browser flags and separately bundled Node SOCKS gateway, connected through the actual Bun server relay to a controlled Node device peer. The peer mapped a reserved test hostname to isolated HTTP and HTTPS servers. Both HTTP/HTTPS page loads, subresources, browser fetch, iframe requests, service-worker installation/network requests, one MiB uploads, four MiB downloads, and WS/WSS echo passed.

A **256 MiB HTTPS download** streamed successfully through the browser, device, relay and proxy without buffering the full response in the network services. This local run measured approximately 0.6 seconds for the transfer; it is not a consumer-network throughput promise. Tests also exercised **64 simultaneous streams** with exact byte equality and refusal of a 65th stream.

Direct localhost browser bypass was rejected. WebRTC produced no direct UDP candidates with the tested flags. Both older and newer Chromium WebRTC switch names are supplied because the initially used legacy switch was ignored by the installed browser; the real-browser test caught this and verifies the current configuration. SOCKS UDP is rejected. Address-policy cases include local/private/metadata, mapped IPv6, special-use and translation addresses, mixed DNS results, DNS pinning, and canceled late DNS results.

The tests close/revoke/switch provider connections, retain the selected source, and assert no fallback to computer-side dialing. A deliberately silent but still-open control channel expires after the 15-second lease and destroys its streams. Reconnecting the selected device creates a fresh epoch without changing the owner's persisted revision or replaying old bytes.

## Test runner limitations

The local macOS Bun executable is **1.3.8**; the repository pins **1.4.2**, which was used in Linux. A macOS monolithic run spanning packages encountered a native runner trap and a file-transfer stream error. The file-transfer test passed unchanged from HEAD and passed in isolation on the feature branch. Computer files were therefore rerun in isolated processes, all successfully on both platforms. Server and desktop/shared suites also completed successfully in their own runs. These results do not claim that the monolithic Bun invocation passed.

The transfer tests also exposed TCP half-close data loss with this older Bun version. The production computer data path now runs in the image's existing Node runtime, with a private configuration pipe and shutdown when its parent exits. Its `.mjs` output avoids dependence on Node's newer automatic module detection.

## Repeat checks

```sh
bun install --frozen-lockfile
bun --filter @openteam/db db:generate
bun packages/plugins/scripts/generate.ts
bun test apps/server/test
bun test apps/desktop/test packages/client-core/test packages/contracts/test packages/plugin-sdk/test
bun test apps/computer/test/browser-network-worker.test.ts
bun --filter @openteam/desktop test:browser-network
bun --filter @openteam/desktop typecheck
bun --filter @openteam/computer typecheck
bun --filter @openteam/server typecheck
bun --filter @openteam/desktop build
bun --filter @openteam/computer build
bun --filter @openteam/server build
bun scripts/performance/check-desktop-budgets.ts
bun run check:architecture
git diff --check
```

Use an installed Chromium path via `CHROME_PATH` where needed. The server browser test skips explicitly if no supported browser executable is installed. For the complete computer regression suite on the older local runner, execute each `apps/computer/test/**/*.test.ts` file in its own `bun test` process; local per-file results are retained in `output/browser-network-tests/summary.json`. Database integration requires `OPENTEAM_TEST_DATABASE_URL` pointing to a disposable schema prepared with `db:deploy`.

To repeat the production-image Linux checks on a dedicated Colima profile:

```sh
colima start openteam-network-test --activate=false --ssh-config=false --cpu 4 --memory 7 --disk 24 --mount none
OPENTEAM_TEST_DOCKER_CONTEXT=colima-openteam-network-test OPENTEAM_TEST_OUTPUT_DIR=output/browser-network-ranking bun run test:browser-network:linux
colima delete openteam-network-test --force --data
```

This requires Docker CLI/build support, Colima, host Bun dependencies and OpenSSL. `--skip-build` reuses the three previously built production images; `--keep` retains only the harness's named test resources for debugging. Run without `--keep` for automatic container/volume/network cleanup. The Colima profile is explicitly temporary and should be deleted when finished.

## Remaining release-environment checks

Packaged Electron installers, physical cross-machine residential public-IP identity, system VPN/proxy permutations, IPv6-only networks and an extended WAN soak remain unverified. The Linux device controllers ran in Node using production code; this was not a packaged Linux desktop-app test. Server, computer and desktop components must be updated together. V1 does not claim an OS isolation boundary between browser and shell processes. Native device routing uses the OS TCP routing table; explicit desktop PAC/application proxies, private-network access, Windows and phone exit providers remain outside v1.
