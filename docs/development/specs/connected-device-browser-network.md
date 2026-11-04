# Connected device browser network

Status: feature implemented in `feat/connected-device-browser-network`; the detailed design below also records proposed follow-ups. See the implementation notes for the shipped scope and validation.

Date: October 31, 2026.

## Computer-wide routing — November 4, 2026

This change supersedes the browser-only scope in the historical design below. The source selection and ranked fallback policy now apply to the entire bot computer container: every desktop, dock launcher, shell, installed application, and root/sudo command. The Azure host and the server/database containers retain their own networks. Administrators inside the computer can still deliberately change kernel networking; this is a routing default, not an administrator isolation boundary.

The production computer image enables `OPENTEAM_COMPUTER_NETWORK=1`. Before starting applications, the entrypoint installs an atomic nftables policy and creates a persistent `openteam0` TUN. Both IPv4 and IPv6 use a separate routing table with an unreachable default behind the TUN route, so losing the process or interface cannot expose the Docker default route. Applications receive no special proxy environment or browser flags. A pinned tun2socks v2.6.0 binary translates TCP to the existing loopback SOCKS gateway and leased, epoch-fenced relay. Public TCP ports are supported; private destinations remain blocked at the device. Updating the provider desktop is necessary to enable ports beyond 80/443 on older providers.

Only the relay worker loads the socket-mark library. Its transport sockets use the original underlay; UID alone never grants an exemption. Supervisor and application traffic, including root commands, use the TUN. The exact management destination/port and replies to incoming management/VNC connections retain underlay routes, keeping the UI and reconnect path reachable. Management discovery runs asynchronously through marked underlay DNS, before a route lease exists. Startup does not depend on the server already running, and hostname/address changes refresh the hosts entry, firewall sets, and source-selection rules. This preserves Compose's server-after-computer startup order. The supervisor waits for TUN carrier before starting the relay and withdraws the channel if the TUN process dies. Routing/firewall rules persist through all process failures.

UDP and TCP port 53 are redirected before Docker's DNS NAT rules to a bounded loopback DNS service. It sends DNS wire messages over certificate-verified HTTPS to Cloudflare's literal bootstrap address `1.1.1.1:443`, through the selected leased route, with no system resolver fallback. Other outgoing UDP and unsupported protocols are rejected. IPv6 TCP is forwarded through the same route; if the selected exit has no IPv6, that connection fails instead of using Azure. This version does not support UDP applications or ICMP ping.

Exit IP and connection quality probes run in a child without the relay socket mark, using ordinary DNS/TCP just like applications. In-flight results are fenced on route changes. Settings call this **Computer network**, and the sharing consent describes all applications and public TCP connections. Existing API paths retain their `browser-network` names for compatibility. In a source-only development runtime without container enforcement, the previous managed-browser proxy remains available; that mode does not claim computer-wide routing.

Run `OPENTEAM_TEST_DOCKER_CONTEXT=<disposable-context> bun run test:computer-network:linux` for isolated Linux checks of fresh startup before server/DNS availability, changing server addresses, startup blocking, root/user/sudo routing, ordinary and hardcoded UDP/TCP DNS, IPv6, physical-interface bypass, unsupported UDP, process death, interface removal, and surviving management connectivity. It creates no published ports or host mounts, uses no app credentials, and removes its containers and networks after the run.

WAN validation on the Azure testing computer measured 30.6–31.6 Mbps download (three 10 MB responses, median 31.4 Mbps) and 29.2–33.0 Mbps upload (three 8 MiB bodies, median 30.4 Mbps). A 603-second mixed-load run completed 366/366 stability probes without an IP change; independent IP checks and Chromium reported the selected Comcast exit in Washington, DC. The larger 16 MiB download requests were rejected with HTTP 403 and are excluded from throughput measurements; valid 10 MB downloads succeeded. WhatIsMyIPAddress returned 403 through both the kernel route and the SOCKS path; Chromium/IPinfo and IPify confirmed identity. This is a ten-minute check, not a long-term WAN reliability guarantee. TUN crash/recovery and direct-interface bypass were verified separately.

For future installations and updates, merge this change and publish a release containing the rebuilt computer image. Its entrypoint installs the policy on every startup. The testing VM's local image/Compose override is a hotfix, not a published release; installing an older release can replace it. Update provider desktops as well to allow public TCP ports beyond 80/443. Existing source priority and explicit server fallback remain in effect.

References: [Linux TUN devices](https://docs.kernel.org/networking/tuntap.html), [tun2socks routing](https://github.com/xjasonlyu/tun2socks/wiki/Examples), [Linux socket marks](https://man7.org/linux/man-pages/man7/socket.7.html).

## Implementation notes — November 1, 2026

Implemented: authenticated outbound device/computer channels; bounded multiplexed TCP streams; SOCKS5 browser gateway; explicit deployment-wide selection; local desktop consent; public-address and port restrictions; monotonic challenge-bound leases; epoch fencing; source revocation/reconnect; settings, provider status and browser indicator; persisted selection with conditional revisions; and a separately bundled Node worker for the computer's TCP path. The existing image already contains Node. Using it avoids pending-byte loss during TCP half-close in the locally installed Bun version.

Consent lives in its own private, atomic desktop file rather than migrating unrelated computer-label settings. Provider eligibility is proven by a live, locally approved enrolled channel; new offline devices cannot be selected. An offline device keeps its saved priority while the next available ranked entry supplies networking. Status is refreshed through the shared owner API every five seconds rather than persisted SSE counters. The v1 wire protocol uses fixed initial stream windows and challenge/lease plus invalidation/applied acknowledgements rather than separate PREPARE messages. Arbitrary destination port overrides are not exposed. Public-IP diagnostics use the fixed, bounded route-aware lookup described below.

The Node worker receives its configuration over a private stdin pipe and shuts down when that pipe closes, so abrupt gateway exit cannot leave an orphan routing process. It is bundled as `.mjs` for compatibility with the image's Node runtime. Desktop networking loads lazily and the browser indicator is separate from settings to preserve bundle-size budgets.

Verification includes real Chromium HTTP/HTTPS, uploads/downloads, WS/WSS and service-worker requests through the real Node gateway and a controlled device exit; protocol, credit, destination policy, consent, lease expiry, revocation, reconnect and ranked-fallback tests; isolated PostgreSQL persistence/concurrency and enrollment tests; browser-driven settings tests; VNC/command/file regressions; type checks, production builds and desktop performance budgets. Production Linux images and a short multi-browser soak have also been validated; see the validation report. Physical cross-machine public-IP identity, OS VPN permutations and a long WAN soak remain release-environment checks.

## Chaos hardening — November 2, 2026

A peer has six seconds from its first route grant to acknowledge the current epoch. Heartbeat renewals cannot extend this deadline. A non-acknowledging provider is disconnected so the next ranked source can take over; a non-acknowledging broker reconnects. Saved order/revision stay unchanged. A fresh epoch resets the deadline, and a matching acknowledgment clears it.

Reconnects retain exponential backoff across short-lived channels, including channels that briefly grant valid leases. Only a valid lease after a full six-second connected interval resets the attempt counter. Existing jitter and the 30-second base cap remain; a healthy new connection becomes usable immediately. Stream-admission and retry throttles use monotonic time, as leases already did, so wall-clock corrections cannot strand or bypass them.

Desktop identity bootstrap retries transient failures without re-enrollment, preserving local consent boundaries. Pending requests and retries cancel on sleep, sign-out or enrollment replacement; wake retries immediately. Reconnecting waits for already queued consent writes before reading permission, preventing a pending revoke from being overwritten by an old read. Interface comparisons ignore enumeration order and hardware metadata so harmless OS changes do not restart healthy tunnels.

The computer keeps its last validated display dimensions available while refreshing them in the background. A server outage must not block existing browser/desktop controls when that cache expires. Refreshes coalesce, retry after five seconds on failure, and use monotonic cache timing; a cold start still requires valid settings. This does not grant network authority: browser leases still expire and fail closed while the coordinator is unavailable.

The worker publishes route/disconnect status immediately in addition to periodic connection counters. The parent gateway's status snapshot is observational; it cannot reject a diagnostic that the live worker can authorize. Diagnostic commands remain bounded and the worker validates its current lease/route before opening a connection.

Speed-test success/failure caching and cooldowns are scoped to the measured route epoch. A check on the previous exit cannot block testing a new exit for a minute; repeated requests for the same current epoch still coalesce and retain their cooldown. Old in-flight results remain fenced.

`bun run test:browser-network:chaos` exercises seeded enrollment/disconnect/reorder/broker-restart/concurrent-edit sequences, simultaneous reconnects, late dial completions, missing acknowledgments, transient database failures, single-destination failures without replay, clock jumps, transport-write failure and desktop consent/lifecycle races. Set `OPENTEAM_NETWORK_CHAOS_SEED` and `OPENTEAM_NETWORK_CHAOS_STEPS` (1–200) to reproduce a fault sequence. `bun run test:browser-network:linux --chaos` adds actual kernel delay/jitter/seeded loss, interface down/up, identity bootstrap failure, relay freeze/recovery and simultaneous provider freeze/recovery to the normal production-image harness. It requires an explicit disposable Docker context. Faults affect only fixture namespaces; loss statistics must show actual dropped packets. See the validation report for measured results and remaining physical-device coverage.

## Faster failover and active-exit quality checks — November 2, 2026

Sleep/quit/closed-channel fallback remains event driven. Silent failure now expires a six-second lease renewed every two seconds, checked on the coordinator's 250 ms timer. Keep the existing 30-second stable-return delay and saved ranking, including the server at its ranked position. This is not seamless transport migration: old TCP/TLS/WebSocket connections close on epoch changes, and sent requests are never retried automatically.

A newly selected provider must acknowledge the current epoch before the broker receives an available route. Its first acknowledgment wakes the broker immediately rather than waiting for the next periodic renewal. During an announced transition, the broker can hold up to 64 **unsent** open requests for at most two seconds; unavailable/expired/disconnected routes remain fail closed. Queued requests cancel on disconnect and expire without sending/replaying data. Already-open streams remain fenced. Invalidation also clears outstanding lease challenges so delayed old grants cannot restore a prior epoch. Data already in flight is discarded until the peer acknowledges the new epoch; WebSocket ordering guarantees it precedes that acknowledgment, so stale bytes do not unnecessarily close otherwise healthy control channels. After acknowledgment, invalid data still closes the channel.

Both Server settings screens expose a manual, compact **Connection test**. The owner-only `POST /api/v0/server-settings/browser-network/quality` forwards over authenticated computer HTTP to the Node worker. A fixed `speed.cloudflare.com:443` HTTPS destination is opened through `BrowserNetworkClient.open`, so latency and throughput cover the computer → relay → active exit → public endpoint path. Server-mode checks use the computer's existing direct route. TLS verification/SNI remain enabled; no arbitrary URL, redirect, non-identity encoding or UDP endpoint is accepted. There is one warmup, three zero-byte request latency samples (median), one 1 MiB download and one 256 KiB upload over HTTP keep-alive. Report HTTP request/response latency rather than ICMP ping; download Mbps uses body-transfer time, upload Mbps includes response acknowledgment. These small samples estimate effective speed, not maximum link capacity.

Results include epoch, source ID, check time, latencyMs, downloadMbps/uploadMbps and exact sample byte counts. Validate source and epoch before/after the probe, discard results on route changes, cap download and upload-response bytes, enforce a 20-second overall deadline and destroy late sockets. Cache success/failure for one minute with one concurrent check; separate IP and quality checks can each have one bounded in-flight command. UI testing state is independent of ranking edits. No automatic background throughput test, source hopping, measurement history or external telemetry submission is added. Reference: [Cloudflare's official speed-test endpoint and latency documentation](https://github.com/cloudflare/speedtest).

## Compact Server settings and exit diagnostics — November 1, 2026

Desktop networking is a compact, lazily loaded section in **Settings → Server**. It uses the existing `@dnd-kit/react` sortable API with pointer handles, keyboard lift/move/drop and Escape cancellation. Native iOS exposes the same ranking under **Settings → Server**, with SwiftUI list reordering and accessibility move actions. Rows have a rank, device icon, name, Working/Not working status, with a subtle **In use** pill replacing the status on the active source. The desktop app appends **(current)** to its enrolled computer using the local enrollment machine ID, independently of active routing; unenrolled and remote computers are not marked current. Explanatory row subtitles and large connection cards were removed. Desktop Apply/Discard appear only for a changed draft; iOS Apply remains in the navigation bar.

Device Working status means an enabled, locally opted-in authenticated provider has a fresh lease, independent of generic enrollment presence. It does not use individual website failures to hop providers. The server is always an eligible fallback. The active connection is separately reported from applied runtime state.

Exit IP and approximate city/country are hidden by default using the desktop endpoint's shared blur/reveal component and a native tap-to-reveal row on iOS. Hidden values are excluded from accessibility text. They hide again on value/route changes and app backgrounding. A route-epoch change invalidates displayed results immediately; failed checks show Unavailable.

The owner-only `POST /api/v0/server-settings/browser-network/egress` forwards to the authenticated computer endpoint. The Node worker opens **ipwho.is:443 through `BrowserNetworkClient.open`**, the same leased transport as managed browsers, and verifies the destination TLS certificate/SNI. Device DNS remains device-side. The HTTPS GET has a fixed host/path/fields, no redirects, no arbitrary destination input, an 8-second total deadline, an 8 KiB JSON response cap and sanitized errors. Only IP, location, source, epoch and check time are returned. Worker IPC is private and bounded; credentials and diagnostics are not logged. Success and failure are cached for two minutes per epoch and concurrent requests coalesce. Server validation rejects source/epoch mismatches and routes that lost their lease while checking. There is no direct-network fallback. Checks run while the settings screen is visible; no persistent IP history is stored.

References: [dnd-kit sortable API](https://dndkit.com/react/hooks/use-sortable/), [sensors and keyboard input](https://dndkit.com/react/guides/sensors/), [Pragmatic DnD accessibility responsibilities](https://atlassian.design/components/pragmatic-drag-and-drop/accessibility-guidelines), [IPWhois HTTPS/field filtering documentation](https://ipwhois.io/documentation). dnd-kit fits this existing React sortable UI and already powers the sidebar; iOS keeps native SwiftUI reordering.

## Ranked connection update — November 1, 2026

The owner requested an ordered fallback list with the server as a regular entry. **Ranked connections is always enabled**; neither client exposes manual server/device modes. The server must occur exactly once and can appear anywhere among up to 16 approved computers. Computers below the always-available server are not selected. Drag/drop and keyboard/accessibility move actions edit a draft; Apply conditionally persists the entire list and confirms the resulting source changes.

The server coordinator selects the first eligible entry. Devices need a current locally approved authenticated channel and a fresh lease. Socket close, consent withdrawal, sleep, enrollment revocation and a 6-second lease expiry remove eligibility; fallback happens without rewriting the saved order or owner revision. A higher-priority returning device must remain continuously eligible for 30 seconds before preempting a healthy current source. A direct owner reorder applies immediately. A website's DNS/TCP/HTTP failure alone never causes source hopping or request replay.

Each effective source change creates a fresh epoch, closes old streams (including server-mode direct sockets), and sends new leases to the computer and devices. Browser windows and profiles remain open. Standby-device activity does not interrupt an unchanged active source. Effective wire routes remain `server` or `device`; `ranked` is the persisted policy mode. Live status reports the effective provider rather than merely the first ranked computer.

New settings default to `mode = ranked`, `machineId = null`, and `sourceOrder = [server]`. Existing server/device rows migrate with a conditional revision update, preserving the former preferred source and including the server. Legacy API source-selection requests are translated into ranked policies; persisted settings remain ranked. Ranked settings require one `server` entry and unique, bounded identifiers. On the first validated lease from a locally opted-in provider, the coordinator serializes an automatic pool addition with owner edits. It inserts before a last-ranked server; when the owner has elevated the server, it appends without overriding that choice. Existing IDs do not duplicate, and ordinary reconnect does not rewrite priority or revision. Offline entries remain visible and reorderable. Local consent remains required on each enrolled macOS/Linux device connected to the same deployment. Agents cannot edit rankings or grant consent.

Linux production-image validation has also been completed for the original flow; see [the validation report](connected-device-browser-network-validation.md). Physical WAN/VPN and packaged desktop installer checks remain separate release checks.

## 1. Outcome and decisions

An owner can select an enrolled desktop as the network connection for OpenTeam's managed bot browsers. Browsers continue running on the Linux computer; website connections and destination DNS resolution originate on the selected desktop. Browser profiles, cookies, files, rendering, and automation stay on the computer service.

For example, OpenTeam can run on a cloud server while its browsers connect to a public website through an owner's Mac at home. The website observes the Mac's connection. This does not import the Mac's browser session or make the website treat the bot as a human.

The first release makes these decisions:

- One ranked priority for all managed browsers. The server is a required normal entry and can be ranked anywhere.
- Desktop exit providers on macOS and Linux. Windows can follow after its packaging and network tests pass. The native iOS app manages the same priority, without providing an exit connection.
- The provider grants permission locally before another client can select it. Existing enrollment and command/file permissions do not grant network sharing.
- Unavailable devices fall through to the next eligible ranked entry, including the server at its saved position.
- Desired selection/order is sticky. Sending a message or bringing an app to the foreground never changes it. Availability can change the effective source in ranked mode.
- Device routing supports public HTTP, HTTPS, WS, and WSS traffic. Private-network access, arbitrary desktop services, UDP, and system-wide routing are outside this release.
- A loopback SOCKS5 broker on the computer service is the stable browser proxy. A separate WebSocket data channel connects desktop and computer through the existing server origin.
- Route changes close existing browser network connections. They do not restart browsers, reload pages, or replay requests. A one-time browser restart is required only when upgrading an already-running browser that lacks proxy configuration.

The design does not require inbound ports on the user's desktop, administrator access on that desktop, a VPN client, TLS interception, a Chromium extension, or third-party network infrastructure.

## 2. Existing code and integration points

These observations come from the current checkout, including its uncommitted work. Implementation should recheck these seams before editing; unrelated local changes must be preserved.

| Existing component | Behavior today | Consequence |
| --- | --- | --- |
| `apps/desktop/src/main/host/machine-enrollment.ts` | Desktop enrolls, opens a channel, and long-polls for command/file requests. | Reuse identity and credential lifecycle. Do not carry browser byte streams through this polling queue. |
| `apps/server/src/machine-relay.ts` | Bounded, authenticated request relay with upload staging and no replay of mutations. | Keep this channel independent so downloads cannot delay commands or enrollment presence. |
| `apps/server/src/services/machine-service.ts` | Credentials are hashed and enrollment is tied to an authenticated session. Disabled machines and revoked sessions become unroutable. | Network sockets must participate in the same revocation lifecycle. |
| `packages/db/prisma/schema.prisma`, `HostMachine` | One deployment owner's roster; direct and relay transports. | Add network capabilities to relay enrollment. Manually registered direct bridges are not exit providers in v1. |
| `apps/computer/src/screen-broker.ts`, `openApp()` | Starts each managed Chromium process and owns its profile and CDP attachment. | Configure the proxy here for every screen, including browsers opened through MIME handlers. |
| `docker/openteam-browser` | Routes normal browser launches through the screen launcher. | Preserve this path and test it; do not create a second unmanaged launch path. |
| `apps/computer/src/browser/use.ts` and `browser/run-code.ts` | Browser tools attach to the managed browser over CDP. | Proxy the browser process, not individual automation calls. |
| `apps/server/src/main.ts`, `screen-vnc.ts` | Bun already hosts an authenticated VNC WebSocket endpoint. | Add a tagged WebSocket dispatcher; assigning a second global handler would break VNC. |
| `apps/desktop/src/main/computer-settings.ts`, preload, Computer settings UI | Local settings currently contain a machine label. | Add deployment-scoped local sharing permission and a guarded IPC surface. |
| `packages/client-core/src/client.ts` | Shared client methods expose machines and computer display settings. | Add shared network contracts/client calls; renderer and future mobile controls consume the same server view. |
| `apps/computer/src/builtin-fetch.ts` and `public-web-url.ts` | WebFetch has a separate HTTP client and public-address validation. | It is not browser traffic. Preserve its existing route; reuse audited address classification in a runtime-neutral package. |

The inspected Grok Bot desktop used authenticated WebSocket multiplexing and local TCP dialing. That confirms the general approach is practical. OpenTeam's protocol, consent model, names, ports, and state machines below are independently specified; do not copy proprietary bundled code.

## 3. User experience

### 3.1 Settings → Server → Browser network

Always display **Connection priority**, with device names, availability and effective-provider status. Do not display a mode picker or a separate Add step. Drag/drop and keyboard/accessibility move actions edit a draft. **Apply** conditionally persists the complete order using the revision captured when editing began, with a confirmation explaining that route changes interrupt transfers. A stale draft receives 409 and refreshes saved state instead of overwriting another client's changes.

The native iOS screen is **Settings → Server → Browser network**, using native reorder handles, accessibility move actions, **Apply priority**, **Discard changes**, per-device status and private exit-IP/location rows. Both clients call the same owner endpoint. iOS polls every three seconds while active; desktop polls every five seconds. Neither client grants sharing permission remotely.

Status describes the active connection, not the first draft entry. All bot browsers use the first eligible saved connection. Local/private destinations remain blocked through device providers. Terminal, model and plugin traffic retain their existing paths.

### 3.2 On the provider desktop

Add a separate local switch: **Use this computer as network**. Default off. Turning it on shows the target OpenTeam server's origin and explains that all managed bot browsers on that deployment may connect to public sites through this device while its desktop app is running.

Enabling sharing opens the authenticated provider channel; its first validated lease automatically adds it to the saved ranking pool. No second selection action is required. The switch is editable only in the local desktop UI through validated main-process IPC. Remote settings can withdraw permission by disabling the machine but cannot grant it.

Permission is stored against `(deploymentId, normalized server origin/base path, machineId)`. A new deployment identity or server address requires a new local grant. An origin change never inherits an unrelated server's permission. Label changes do not invalidate it. Restarting the app preserves permission. Signing out stops all channels immediately; enrolling again still requires a valid owner session. Restoring/cloning a server while preserving both identity and address preserves that trust; documentation must make this explicit.

Turning the local switch off immediately closes all exit sockets and the tunnel, even if the server is unreachable. It preserves that computer's saved position, marks it unavailable, and advances effective routing to the next eligible entry. The server must not turn sharing back on during recovery.

### 3.3 Visible state

| State | Settings text | Browser panel indicator |
| --- | --- | --- |
| Server applied | Using the server connection | Server connection |
| Change not yet acknowledged | Changing browser connection… | Changing connection… |
| Device tunnel and broker ready | Using {device label} | Via {device label} |
| Device disconnected or asleep | Using the next available ranked connection | Via the effective connection |
| Local permission withdrawn | Sharing is off on {device label} | Network sharing is off |
| Enrollment/session revoked | Reconnect {device label} to allow browser networking | Device authorization expired |
| Unsupported computer/browser runtime | Update the computer runtime to use connected-device networking | Computer update required |
| Service or tunnel cannot be reached | Could not connect to the selected network source | Browser network unavailable |

“Ready” means that the broker and device can exchange protocol messages and have applied the same route epoch. It is not proof that every website is reachable. A destination DNS/TCP failure stays a per-request error rather than declaring the entire route broken.

The browser indicator appears on every screen because the selection is global. Status changes must be accessible and independent of color. Account-wide settings expose all device choices; each device's local permission remains local. A small persistent status in the provider app says **Providing browser networking** with a **Stop sharing** action.

### 3.4 Agent behavior

Browser failures return structured codes and useful text: “The selected browser connection is unavailable. Open Computer settings to reconnect {label} or choose another connection.” Do not tell the agent to use shell HTTP requests to escape a selected route.

The model can read network status but cannot grant local permission, change the selected source, enable fallback, or modify destination policy. A browser task may end as blocked when networking disappears. Do not cancel unrelated inference, file work, or plugin tasks. Do not automatically retry form submissions, payments, uploads, or other website mutations whose outcome is unknown.

## 4. Traffic scope and guarantees

### Included

Managed Chromium navigation, subresources, redirects, XHR/fetch, service-worker network requests, browser uploads/downloads, and WS/WSS. HTTPS/WSS TLS remains between Chromium and the destination; the desktop forwards bytes without substituting certificates. The destination hostname is resolved on the selected exit device in device mode, including for each new connection after a network change.

### Excluded

Model APIs; WebSearch and WebFetch providers; plugin/MCP network requests; terminal commands; package installs; the desktop UI's own requests; the server/computer control link; CDP and VNC; file transfers through the machine bridge; arbitrary browsers started by a shell; and phone background routing. Do not set global `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` variables.

Browser cookies and user agent remain those of OpenTeam's browser. Website identity checks, CAPTCHAs, account restrictions, and TLS policies still apply. No claim is made that this feature makes automation undetectable.

### Network boundary

This feature controls the configured path used by managed browser processes. It does not create an operating-system isolation boundary between a browser and a terminal running under the same agent identity. An agent with shell access can deliberately use an accessible local proxy or start another browser. The consent wording must accurately authorize the OpenTeam deployment, rather than promise that hostile agent code cannot use the shared path. Public-address checks, local revocation, authentication, and resource limits apply to every stream regardless of its initiating process.

A future guarantee that only designated processes can use an exit requires separate browser network namespaces/cgroups and a protected gateway; it is not a v1 claim. Direct WebRTC/UDP and unexpected managed-browser bypasses are nevertheless release-blocking functional defects.

### VPN and desktop proxies

The exit uses the desktop OS resolver and TCP routing table. A full-tunnel VPN may carry these connections; a split-tunnel VPN follows its own process/destination policy. V1 does not implement PAC/WPAD, HTTP proxy authentication, a SOCKS chain on the desktop, or Chromium session proxy inheritance for raw TCP destinations. Networks that require an explicit application proxy may therefore be unsupported. The desktop's control WebSocket must use the same configured server-connection transport policy as enrollment, and that transport must be verified separately from exit TCP routing.

Do not promise “everything your browser can reach” on the provider device. Raw Node TCP connections and the desktop's interactive browser can have different proxy/VPN behavior. The settings connection check reports errors accurately without changing the OS's proxy or VPN configuration.

## 5. Architecture

The data path is:

`Managed Chromium → computer loopback SOCKS5 broker → computer WSS → OpenTeam server relay → desktop WSS → desktop TCP socket → website`.

The control path is independent:

`Authenticated owner settings → server routing coordinator → versioned route/lease → computer broker and selected desktop`.

In server mode the loopback broker opens destination TCP connections from the computer container, preserving today's server-side egress. It does not send destination traffic through the API server. In device mode the computer broker never opens a destination TCP connection itself.

### 5.1 Computer broker

New modules under `apps/computer/src/browser-network/` own a loopback-only SOCKS5 listener, a route controller, the computer-side multiplexed transport, and status reporting. Default listener: `127.0.0.1:18791`, deliberately distinct from OpenTeam's existing computer API on port 8790. Port configuration must be validated and private; Compose publishes no new ports.

Start the broker before any managed Chromium process. Set `--proxy-server=socks5://127.0.0.1:18791` with a single proxy and no DIRECT fallback. Set `--proxy-bypass-list=<-loopback>` to remove Chromium's implicit local-address bypass. Set resolver rules preventing Chromium from issuing destination DNS outside the proxy, with the numeric proxy address excluded. Disable QUIC and non-proxied WebRTC UDP. Verify the actual flags/policies against the packaged Chromium, not only unit tests. Reject conflicting launcher flags or profile policies rather than starting a browser whose route is ambiguous.

SOCKS5 supports only CONNECT. Accept domain, IPv4, and IPv6 forms with strict length and port validation. Refuse BIND and UDP ASSOCIATE. Incremental parsing must handle split and coalesced reads. Domain bytes represent an IDNA ASCII hostname; reject embedded NULs, whitespace, credentials, paths, and malformed literals. Never send destination bytes before OPEN_OK. Map route/dial errors to valid SOCKS reply codes and the structured browser-network error view.

In device mode, do not resolve domain targets on the computer or relay. In server mode, resolve in the computer's normal environment. The SOCKS listener has no password because packaged Chromium does not support SOCKS5 authentication; loopback binding and the deployment's existing process trust boundary are explicit constraints.

The broker must begin in **uninitialized/blocked**, even if the last persisted selection was server. It obtains authoritative state before allowing traffic. It never reads “missing state” as permission to use server egress. A broker restart or loss of its route lease closes all sockets and waits for reconciliation.

### 5.2 Server coordinator and relay

New `BrowserNetworkService` owns desired settings, revision checks, provider eligibility, runtime observations, route epochs, lease renewal, and revocation. New `BrowserNetworkRelay` forwards bounded protocol frames between a registered computer socket and the selected authorized provider socket. It never resolves or dials website destinations.

Use the current public API origin, including its supported base-path configuration. TLS deployments use WSS. Plain WS is allowed only under the deployment's existing explicitly configured trusted local/private HTTP setup; do not downgrade or disable certificate verification. Reverse proxy configuration must pass WebSocket upgrades and have timeouts longer than the protocol heartbeat interval.

Refactor the server WebSocket generic into a tagged union such as `VncConnection | BrowserNetworkConnection` with `kind` dispatch for open/message/drain/close. Preserve VNC tickets and all existing VNC limits. Network sessions have their own queue and limits, not the host command queue or VNC buffer.

V1 assumes the current single API process and single computer service. Socket pairing and leases are process-local; do not run this endpoint behind non-sticky multiple server replicas. On restart both peers reconnect and old epochs expire. Multi-replica coordination requires a later shared relay/lease design, not only a database table.

### 5.3 Desktop exit

New `apps/desktop/src/main/browser-network/` owns local consent, an outbound WebSocket, destination validation, OS DNS, TCP sockets, and status. It runs outside the renderer. Keep route secrets and machine credentials in the main process; renderer IPC exposes only redacted views and local permission mutations guarded by the existing sender checks.

Integrate with `DesktopMachineEnrollment` through a lifecycle observer, not by exposing its private credential to the renderer. On successful enrollment, provide a main-process-only handle with server identity, machineId, credential, and connectionId. Credential rotation, channel replacement, sign-out, server changes, and stop events close the previous exit session. Reconnect enrollment must not inherit a stale tunnel or stream ID map.

Only locally approved devices advertise the ability to provide networking. They may keep an idle authenticated tunnel open while eligible, bounded to 16 devices per deployment, but only the selected device receives OPEN frames. This avoids a polling delay when switching sources. Old desktops continue ordinary enrollment and simply lack the network capability.

## 6. Data model, API, and status contracts

New runtime-neutral contracts belong in `packages/contracts/src/browser-network.ts` and are exported through the package's established subpath mechanism. Do not add server imports to renderer code. New binary codec code should be platform-neutral and separately fuzzable.

### 6.1 Persisted settings

Add a singleton `BrowserNetworkSettings`:

```ts
type BrowserNetworkSettings = {
  id: "global";
  deploymentId: string;        // UUID, generated once; not a credential
  mode: "ranked";
  machineId: null;
  sourceOrder: string[];       // unique IDs plus exactly one "server"; default ["server"]
  revision: number;            // monotonic safe integer; starts at 1
  updatedAt: string;
};
```

Enforce the mode/machineId invariant in validation and the schema deployment path. Changing labels or runtime state does not increment settings revision. A no-op selection returns the existing revision. Use a transaction with a conditional revision update; stale writers receive 409 with the current settings. Live route epochs, sockets, counters, errors, IPs, and leases are not database settings.

The settings deliberately retain a removed/disabled device's UUID until the owner changes selection. Do not cascade it to null or server mode. If represented by a foreign key, it must preserve a tombstone rather than changing route semantics. Follow the repository's `db:deploy`/Prisma push and raw-schema conventions, not a newly invented migrations directory.

Local desktop settings become a backwards-compatible version 2 with a map of per-deployment grants. Store only identity, normalized address, grant state, and consent timestamp in the existing private local settings file. Never upload that file. Unknown fields and old version 1 labels migrate safely; absent grants default off.

### 6.2 Capabilities

Extend enroll/poll parsing compatibly with `capabilities.browserNetwork` containing protocol version 1, platform, app version, and `sharingAllowed`. Older clients omit it. Server observations record the current connectionId, last capability update, and eligibility reason. The roster exposes support/permission/availability without exposing enrollment credentials. Do not infer availability from a stale `lastSeenAt` alone.

Offline selection may use last known supported/granted capability, but no traffic is allowed until a fresh authenticated attachment proves current permission and connection identity. An exit attachment without matching current enrollment or local consent is rejected even when the desired device UUID matches.

### 6.3 Owner endpoints

Under the existing authenticated `/api/v0` API:

| Method and path | Contract |
| --- | --- |
| `GET /server-settings/browser-network` | Desired settings, effective status, candidate devices, runtime capability; Cache-Control no-store. |
| `PATCH /server-settings/browser-network` | `{ expectedRevision, mode, machineId, sourceOrder? }`; strict schema, source validation, conditional update. Ranked mode uses a null machineId and a complete source order. |
| `POST /server-settings/browser-network/retry` | Reconnect the currently desired source; body includes expectedRevision. Never replays website work or changes selection. Rate limit to once per five seconds. |
| `POST /server-settings/browser-network/check` | Optional explicit diagnostic through the selected path, bounded as described below. Never changes settings. |

Device selection, retry, and diagnostics follow owner/session authorization and existing origin/CSRF rules. No agent tool or ordinary machine credential can call the mutation endpoints. No endpoint accepts an arbitrary upstream URL or proxy server from the request.

With the existing authentication-disabled deployment mode, settings inherit that mode's trusted-network assumption: anyone who can reach the owner API has the owner's control. Local sharing consent still defaults off and scopes to that deployment, and all data-channel credentials/stream validation remain required. Do not advertise authentication-disabled deployments as safe to expose publicly or silently introduce a separate login flow for this feature.

Return a typed view:

```ts
type BrowserNetworkView = {
  settings: BrowserNetworkSettings;
  runtime: {
    state: "server" | "applying" | "ready" | "waiting_for_device"
      | "sharing_disabled" | "authorization_required" | "update_required"
      | "unavailable";
    appliedRevision: number | null;
    activeMachineId: string | null;
    routeEpoch: string | null;
    reasonCode: string | null;
    lastChangedAt: string;
    activeConnections: number;
    bytesSent: number;
    bytesReceived: number;
    blockedConnections: number;
  };
  devices: BrowserNetworkDeviceView[];
  runtimeCapability: { protocolVersion: number | null; managedBrowsersConfigured: boolean };
};
```

Byte counts are network-byte counters since the current epoch, from the browser's perspective. A route can be applied but waiting. `activeMachineId` is non-null only with a live paired route. `appliedRevision` is the broker's acknowledgement, never inferred from a successful DB write. Views from different channels carry revision/epoch so clients discard stale updates. Reason codes are stable enums; user text is mapped on the client.

Publish a redacted `browser.network.changed` product event on desired changes and important status transitions; add it through the existing contracts/event validation. Coalesce flapping updates to at most one per second. Do not persist per-second byte counts or one event per stream in the product log. Settings can poll the status endpoint every five seconds while open for counters; the browser indicator uses events plus a refresh on reconnect.

The current mutation body is `{ "expectedRevision": 1, "mode": "ranked", "machineId": null, "sourceOrder": ["<enrolled UUID>", "server"] }`. Older source-selection clients are translated into ranked policies for compatibility. Reject extra fields, a missing revision, or a non-null machineId in server mode. Use 400 for invalid input, 401/403 for failed authorization, 409 for revision conflict or device ineligibility, 429 for rate/capacity limits, and 503 when authoritative state cannot be read. An accepted device that subsequently goes offline is a status transition, not a rollback of a successful mutation. Current desired selection may be returned with 202 even when its runtime is waiting. Include the current view in revision-conflict responses, without credentials.

### 6.4 Streaming endpoints

- Desktop: `GET /api/v0/machines/channel/browser-network` with WebSocket upgrade, machineId, enrollment bearer, and current connectionId headers. Authenticate with `MachineService.authenticate()` and verify the connection generation before upgrade. Only accept the configured native/main-process channel; reject unexpected browser Origins. Do not accept a machine bearer from a URL or cookie.
- Computer: `GET /api/v0/internal/browser-network/channel` with WebSocket upgrade and the existing internal service authentication. It identifies a fresh broker instance UUID. Only one computer session is active; replacing it fences and closes the previous session and all streams.
- Subprotocol: `openteam-browser-network.v1`. A missing/unsupported version fails explicitly before data flows. Neither peer supplies a destination or arbitrary peer ID in a handshake URL.

These routes must be dispatched before generic JSON body wrapping and before inappropriate owner-cookie handling. Native clients can send authorization headers. Authentication secrets never appear in query strings, product events, diagnostics, or ordinary logs. The shared deployment control token stays on trusted services and is never delivered to a desktop.

## 7. Routing state machine and consistency

### 7.1 Authority

Desired selection is durable. Effective routing exists only under a live server-issued lease bound to `(deploymentId, settings revision, random routeEpoch, brokerInstanceId, provider connectionId)`. In server mode provider connectionId is null. A fresh random epoch is required after every source change, broker replacement, provider reattachment, or authority loss. It is not derived solely from a machine ID or settings revision.

Leases last six seconds on each peer's monotonic clock and renew every two seconds over the control channel. Renewal is a peer-initiated challenge: LEASE_REQUEST contains a fresh nonce, epoch, and sequence; the peer records the request's monotonic start time. A matching LEASE response authorizes use only until **request start + six seconds**, not response receipt + six seconds. Discard expired or superseded challenges. HELLO/PREPARED includes an equivalent fresh challenge for initial activation. This prevents delayed or buffered valid grants from extending a revoked route. A nonce is single-use, pending challenges are bounded, and no clock synchronization is required.

Peers stop accepting new opens and destroy existing route sockets when a lease expires. Never extend a lease using traffic activity, a cached settings response, or wall-clock arithmetic. Server restart cannot resurrect an epoch. A control message contains a strictly increasing sequence within its socket session; the recipient also checks revision, epoch, broker/provider identity, and the matching lease challenge before accepting it.

The server revalidates active enrollment/session authorization at least every 15 seconds and immediately through existing explicit disable/remove/sign-out hooks. On DB/auth uncertainty, stop renewing and close the route; do not renew indefinitely on cached authorization. Authorization revocation is enforced immediately when observed, and within 30 seconds for expiry/external revocation including one in-flight lease. These are separate limits from the host relay's existing 45-second presence window.

### 7.2 Apply sequence

1. Owner PATCH conditionally persists a new desired revision and fences old device frames at the relay. Return an applying view; do not claim completion.
2. The coordinator sends PREPARE for the new revision. The broker pauses new SOCKS opens, destroys sockets from the previous epoch, and acknowledges PREPARED only after cleanup. Old desktop sockets are also closed/reset. No connection migrates between devices.
3. If the selected device is online, approved, authorized, and compatible, pair it with the broker, issue a new epoch/lease, and send ACTIVATE. If absent, apply the desired revision in a blocked/waiting state. Server mode activates broker-local dialing under its own epoch.
4. Mark the revision applied only after the broker acknowledges its new state and, in device mode, the matching device acknowledges activation. Expose ready only after both are paired and leases are current.
5. Resume new opens. Existing pages remain open and may issue their own fresh requests. OpenTeam itself never replays a request.

During a healthy connected change, old sockets should close within one second and the transition should complete within five seconds. These are measured acceptance targets, not atomic distributed-system guarantees. A partitioned old broker can continue only until its last six-second lease expires; UI remains applying/unavailable until acknowledgement. On an in-process device revoke the desktop closes locally without waiting for any acknowledgement.

If several changes race, only the newest accepted revision can activate. An old PREPARE/ACK/ACTIVATE is ignored by revision/epoch checks. A PATCH with a stale expectedRevision returns conflict. Ordinary reconnects renew the same desired choice with a new epoch and never increment desired revision.

### 7.3 Loss and recovery

- Device sleep, quit, TCP loss, or local revoke: close current streams and choose the next eligible ranked entry, including the server at its saved position. Retain desired order; never replay already sent browser bytes.
- Tunnel failure: close both halves and discard in-flight frames. Retry the transport with exponential backoff from one to 30 seconds and jitter. Streams are never resumed or retransmitted on a new tunnel.
- Desktop identity bootstrap: bound each request to five seconds and retry failures with exponential one-to-30-second backoff and ±20% jitter. Until authenticated deployment identity and local consent are both loaded, sharing stays off. Consent reads wait for previously queued local writes, so reconnect cannot resurrect a pending revoke. Sign-out, enrollment replacement and sleep abort outstanding bootstrap requests and retries; wake retries immediately. Late results cannot replace the current enrollment.
- Device network change: destroy its exit sockets, clear connection DNS results, then reconnect and activate a new epoch. Avoid keeping connections from two VPN/network identities after a confirmed change.
- Compare sorted, non-internal interface addresses, families, masks and IPv6 scopes. Enumeration order and hardware metadata alone do not restart a healthy tunnel. Poll for changes every five seconds; resume checks immediately. Kernel/interface tests supplement physical Wi-Fi/VPN release checks.
- Browser proxy unavailable: Chromium fails rather than bypassing it. Broker restart waits for authoritative state before accepting new opens.
- Server restart: use persisted desired settings but start all effective state blocked; peers reconnect and receive a fresh epoch.
- Disable/remove machine, session expiry, sign-out, or credential rotation: invalidate all associated provider sockets and leases. A disabled machine cannot reenroll until explicitly enabled. Reenrollment never restores stale streams.
- Computer starts before server/DB: keep the proxy bound and refusing connections until state is authoritative. It must not choose the server because the network settings endpoint timed out.
- Owner deliberately returns to server mode: apply the same connection teardown/barrier, then dial from the computer. Local provider permission may stay granted but is inactive.

## 8. Multiplexed transport protocol

Use ordered binary WebSocket messages, compression off. Protocol frames have a 12-byte header: `version:u8`, `type:u8`, `flags:u16`, `streamId:u32`, `payloadLength:u32`, with multibyte values in network byte order. One WebSocket message contains exactly one frame. Reject trailing bytes, unsupported flags, version mismatch, and length mismatch.

Stream ID zero is reserved for bounded JSON control messages: HELLO, PREPARE, PREPARED, ACTIVATE, ACTIVATED, LEASE_REQUEST, LEASE, STATUS, and GOAWAY. HELLO identifies role and supported protocol; the server determines identity from authentication. Control payloads are at most 4 KiB. Enforce message schemas and rate limits. No peer can use a control frame to select its own arbitrary destination device.

Wire version is 1 and flags must be zero in v1. Type codes are `CONTROL=0`, `OPEN=1`, `OPEN_OK=2`, `OPEN_ERR=3`, `DATA=4`, `WINDOW_UPDATE=5`, `FIN=6`, and `RESET=7`. CONTROL is valid only at stream zero; other types require a nonzero stream. OPEN, OPEN_OK, OPEN_ERR, and RESET payloads are schema-validated UTF-8 JSON. DATA is raw bytes; WINDOW_UPDATE is exactly one positive big-endian u32; FIN has zero payload. Types and control operation names not understood by v1 fail the session, rather than falling through to data forwarding.

CONTROL payloads use `{ op, sequence, revision?, routeEpoch?, nonce?, ... }` with strict per-operation schemas. Sequence and revision are safe positive JSON integers; epoch and instance IDs are UUIDs; nonces are 32 random bytes encoded as base64url. The server overwrites peer identity from authentication instead of trusting identity fields. ACTIVATE and LEASE explicitly name the authorized mode and paired identities and echo the recipient's challenge. STATUS is observation only and never extends authority. GOAWAY contains a stable reason, never a user-controlled URL or raw exception. Pin these schemas and numeric assignments in the shared contract before the first independently deployed peer ships.

For nonzero stream IDs:

| Frame | Meaning |
| --- | --- |
| OPEN | Broker requests `{host, port, revision, routeEpoch, receiveWindow}`. Desktop verifies selection, lease, policy, consent, and capacity. |
| OPEN_OK | Exit TCP connect succeeded; includes initial receiveWindow. Only then does broker send SOCKS success. |
| OPEN_ERR | A stable bounded reason: `device_unavailable`, `not_authorized`, `destination_blocked`, `port_blocked`, `dns_failed`, `connect_failed`, `connect_timeout`, `capacity_exceeded`, or `stale_route`. No raw target/error text. |
| DATA | Up to 64 KiB of ordered bytes, bounded by the receiver's advertised credit. |
| WINDOW_UPDATE | Unsigned consumed-byte count allowing the sender more credit; enforce overflow and maximum-window checks. |
| FIN | End of this sender's byte direction after preceding DATA; supports TCP half-close. |
| RESET | Abort this stream and both corresponding TCP/proxy halves; bounded reason code. |

The broker allocates increasing nonzero IDs and never reuses them within a computer transport session; reconnect resets all maps. Before wraparound, drain/close the session and reconnect. The relay maintains a stream-to-epoch/provider map: a provider cannot inject an OPEN, use another provider's stream, or send frames for an old epoch. Desktop DATA before OPEN_OK, over-credit data, DATA after FIN, repeated OPEN, and unknown stream injection are protocol errors. Late frames for a bounded recently-closed stream tombstone may be discarded; never reinterpret them as a new stream.

Control ordering is per WebSocket session, including both directions' independent sequence counters. Reject duplicate/non-increasing sequences. Normal FIN closes only its direction after queued writes drain; remove the stream after both directions finish, or immediately on RESET/error/route teardown. Keep at most 1,024 closed-ID tombstones for 60 seconds. The receiving TCP socket and relay mapping must tolerate a half-close while the other direction remains active. WINDOW_UPDATE is credit for one sender's byte direction; it is never forwarded or applied to the opposite direction.

OPEN acceptance has a 15-second total deadline including at most five seconds of DNS and the remaining TCP dial time. Resolve on the desktop, validate the complete answer set, then dial a chosen validated literal address without a second name lookup. Allow a bounded IPv6/IPv4 race over validated public addresses. Late DNS/dial callbacks after cancellation, revocation, or epoch change must be discarded and any resulting socket destroyed.

### 8.1 Backpressure and resource limits

Initial limits, adjustable by operators within validated bounds:

- 64 live streams per deployment/provider pair; 16 concurrent opens and 32 opens per second with a burst of 64.
- 64 KiB maximum DATA frame; 4 KiB maximum control/OPEN payload.
- 128 KiB maximum receive credit per stream direction; replenish after downstream socket writes complete, in increments up to available capacity. Never grant credit merely because a WebSocket callback ran.
- 16 MiB total retained buffers per component, including socket queues, stream pending data, and WebSocket send buffers. Allocate receive windows under this aggregate budget. Pause upstream TCP reads before the cap; reset a slow stream or close the tunnel on overflow. No unbounded per-stream pending array and no disk spooling of website data.
- Bounded fair scheduling across streams so a large download cannot starve control messages or small website requests. Reserve control capacity and service it before queued DATA.
- WebSocket ping every 10 seconds; absent liveness for 30 seconds closes the session, while the shorter six-second route lease independently prevents prolonged stale routing. The lease is the authority limit.
- An idle TCP stream expires after 30 minutes. Downloads/uploads can run for hours while making progress and leases remain valid; there is no whole-response or total file-size buffer.

Validate limits independently in broker, relay, and desktop. Disable per-message compression, avoid synchronous payload inspection, and expose aggregate queue high-water marks for diagnosis. A receiver-credit protocol is required because a successful WebSocket send does not mean the website has consumed the bytes.

## 9. Destination policy and privacy

V1 device routing allows public unicast destinations on TCP ports 80 and 443. An advanced owner configuration may extend an explicit port allowlist to 8080/8443 or other reviewed ports, but this is not a per-request model decision. Device exit is not an unrestricted general TCP proxy. Initial UI need not expose advanced ports; the settings documentation must state the default.

Move or reuse audited public-address classification from `apps/computer/src/public-web-url.ts` into a shared runtime-neutral module consumable by desktop and computer without importing computer runtime dependencies. Add test vectors for all supported address families and special-use ranges. Do not assume one library's broad “unicast” label alone proves an address is safe for this feature.

The desktop enforces the policy on every OPEN:

1. Canonicalize hostnames/literals; reject localhost names, `.localhost`, `.local`, scoped IPv6 literals, ambiguous/legacy numeric forms, and malformed targets.
2. Resolve with the device's OS resolver. Reject the entire answer set if any answer is private/reserved or cannot be classified safely; a mixed public/private DNS answer is blocked.
3. Block loopback, link-local and cloud metadata, RFC1918, CGNAT/Tailscale ranges, IPv6 ULA, multicast, unspecified, broadcast, documentation/benchmark and other reserved ranges. Normalize IPv4-mapped IPv6 and known translation/transition encodings before classification. Block ambiguous translation mechanisms; IPv6-only/NAT64 compatibility needs explicit validated support, not optimistic address acceptance.
4. Pin the validated literal for TCP dial. Check lease, local permission, and epoch again after asynchronous DNS and connect callbacks. Do not reopen the hostname through a library default lookup.
5. Apply any future deployment destination restrictions as an additional intersection. A remote policy can narrow local permission, never broaden it.

This policy does not change server mode's existing local/private reach: server mode retains existing behavior and any existing restrictions. Switching to device mode can therefore make server-local pages unavailable, which the UI and error text must explain.

No TLS man-in-the-middle. Do not install certificates or accept invalid website certificates. The relay can see destination host/port and byte counts; plaintext HTTP traverses trusted relay memory and is not made end-to-end confidential by WSS. Device, server, and their network operators have ordinary traffic visibility. HTTPS content stays encrypted to the destination.

Production logs contain reason codes, redacted session identifiers, aggregate counts, durations, and protocol version. Do not log hostnames, IP addresses, paths, headers, cookies, payloads, enrollment bearers, or route handshake secrets. A local, explicitly requested diagnostic may show its own public IP to the owner but must not persist it, send it to analytics, or include it in model context automatically. Keep cumulative counters ephemeral and reset on epoch changes.

## 10. Browser integration and diagnostics

All screens must use the broker, whether opened by a browser tool, computer-use action, desktop dock, or a normal HTTP(S) MIME handler. Ensure startup readiness verifies the broker is bound and the browser launch configuration is compatible, without requiring an external website to be reachable.

For existing browsers launched before this capability, expose `update_required`; block selecting device mode until the browser runtime can be restarted safely. Do not kill a live browser holding an unsent form without the owner choosing a browser restart. Keep its profile/cookies intact. Once upgraded, switching sources never requires a browser process restart.

Use Chromium's supported proxy setup with destination DNS disabled outside the proxy. Suppress direct QUIC, WebRTC UDP/STUN/TURN paths that bypass the proxy, DNS prefetch, secure-DNS escape paths, and unwanted browser background discovery. Inventory flags and managed policies for the exact packaged browser. Unsupported WebRTC calls/WebTransport should fail with a clear limitation rather than use a direct route. A service worker, extension, or profile setting must not override the required proxy; detect or prevent conflicts in the managed launch/profile path.

The proxy routes network bytes but does not clear page caches, service-worker storage, cookies, or browser identity. A cache hit is not evidence that the new exit works. Existing TCP pools are invalidated by closing every broker stream, including server-mode streams, during the route barrier.

The default **Check connection** performs a local protocol round trip and reports paired peer/lease health without contacting a third party. An explicit public-IP test can make a fresh, cache-busted browser request through the same managed path to an operator-configured, fixed HTTPS diagnostic endpoint. It must not accept an arbitrary target from the model, must use no browser account cookies for the diagnostic origin, must have a five-second limit and 16 KiB response limit, and must not submit the reported IP to OpenTeam telemetry. A failed diagnostic endpoint is distinct from a broken tunnel. Development acceptance tests use controlled echo endpoints rather than a production user's signed-in browser.

Integrate structured network status with `browser/reference-driver.ts` errors. Avoid treating every website timeout as device disconnection. Surface `destination_blocked` and `port_blocked` specifically, without exposing another device's private DNS results. The host enrollment channel, VNC, and chat remain usable while device egress is blocked, enabling recovery.

## 11. Implementation work packages

These are logical implementation/PR boundaries, in dependency order. Each package must preserve existing behavior until the owner opts in. The final feature cannot ship before the end-to-end and failure gates pass.

### A. Shared contracts and persisted intent

- Add browser-network settings, capability, status, reason codes, and protocol version contracts.
- Add shared address-policy and binary-codec modules with meaningful boundary tests.
- Add `BrowserNetworkSettings` through Prisma and the existing deployment process.
- Extend shared client methods and product-event validation.
- Implement revision/CAS settings and eligibility views without exposing a usable exit yet.

### B. Loopback broker and managed browser configuration

- Add `apps/computer/src/browser-network/{socks-server,controller,transport}.ts` and lifecycle wiring in `main.ts`.
- Integrate proxy arguments and profile/network policy through `screen-broker.ts`; preserve `docker/openteam-browser` routing.
- Implement server-mode TCP forwarding through the broker so the stable proxy is exercised before enabling remote exits.
- Add runtime compatibility/readiness reporting and safe upgrade behavior for existing browsers.

### C. Authenticated server data plane

- Add `apps/server/src/services/browser-network-service.ts`, `browser-network-relay.ts`, and owner/internal routes.
- Refactor Bun WebSocket dispatch to preserve VNC while supporting both network roles.
- Add epoch/lease fencing, queue/credit limits, revision acknowledgements, candidate pairing, and revoke hooks in MachineService/session sign-out.
- Verify deployment reverse proxies and remote-access modes pass the data channel without new published ports.

### D. Desktop provider

- Add main-process consent store migration, local IPC, lifecycle integration with `DesktopMachineEnrollment`, and capability advertisement.
- Implement DNS classification/pinning, raw TCP dialing, duplex relay, lease expiry, abort/half-close behavior, and local immediate revoke.
- Stop/restart correctly on sign-out, credential rotation, server changes, app quit, device sleep/resume, and network/VPN changes. Avoid adding power-save blockers by default; explain that the device must stay awake.

### E. Product controls and status

- Add Browser network settings alongside the current Computer and Machine settings, with explicit Apply and interrupt warning.
- Add provider permission and Stop sharing controls; guard all mutations in main IPC.
- Add shared browser-panel indicator, redacted status refresh/events, actionable browser-tool errors, and connection diagnostics.
- Use shared client-core contracts. iOS needs graceful handling of new additive events now; selection controls can ship later without becoming an exit provider.

### F. Release verification and documentation

- Execute the integration, leak-path, load, and failure scenarios below with packaged Chromium and desktop builds.
- Update user computer/network/privacy/troubleshooting docs and remote-access proxy requirements only when implementation ships.
- Add a runbook for blocked WebSocket upgrades, sleeping devices, explicit desktop proxy limitations, blocked private destinations, and expected interruption of downloads on source changes.
- Include an upgrade/rollback compatibility matrix and mixed-version tests.

Likely touched files are the seams in section 2, plus new modules above, desktop preload/global typings, `packages/client-core/src/client.ts`, contracts exports, event validation, server AppService wiring, Compose/reverse proxy configuration if required, and focused tests. Do not put the relay into unrelated plugin or messaging code.

## 12. Verification and release gates

This specification adds no runtime tests to the current tree. The implementation must add tests for actual network behavior and failure boundaries, rather than tests that merely mirror setters or frame constructors.

### 12.1 Protocol and policy

- Split/coalesced SOCKS handshakes; malformed versions/lengths/targets; unsupported commands; IPv4/IPv6/domain targets; invalid and blocked ports.
- Special-use addresses, mapped IPv6, mixed DNS answers, resolver failure/timeout, DNS rebinding, translated addresses, and a late callback after revoke. Assert no destination dial occurred for rejected requests.
- Bad binary headers, unknown flags, duplicate/open-after-close IDs, over-credit DATA, stale epochs, wrong provider connection, payload limits, malformed JSON, and stream-ID rollover.
- TCP half-close, cancel during connect, close during write, abrupt destination reset, and independent simultaneous streams. Assert exact binary contents in both directions.
- A single slow destination must not cause unbounded queues or block unrelated streams/control messages.

### 12.2 Identity and consistency

- An ordinary owner API request cannot grant desktop sharing; an enrolled machine cannot mutate global selection or impersonate another provider.
- Invalid/expired bearer, rotated enrollment, wrong connectionId, disabled/removed machine, sign-out, expired owner session, and old computer socket all stop traffic within the specified limits.
- Local permission revocation closes TCP sockets without a server connection.
- Concurrent selection changes return CAS conflicts; delayed acknowledgements and old lease renewals cannot reactivate an old source.
- Desktop restart, machine-label rename, origin/deployment change, server restart, database outage, and computer restart preserve the intended consent/blocked behavior.
- Existing VNC and machine commands/file transfers continue working during saturated browser traffic and relay failures.

### 12.3 Packaged browser end-to-end

Use a deterministic controlled DNS and echo service. Run the computer and desktop in genuinely distinct network environments when proving exit identity; comparing two processes on one host is insufficient.

1. Default server mode: navigation, subresources, fetch/XHR, WS/WSS, uploads, downloads, redirects, and service-worker requests work through the broker with the previous server exit.
2. Select an approved desktop: the echo service observes desktop egress; the desktop resolves the target domain; packet capture shows no computer-side destination DNS or destination TCP connection.
3. Exercise two bot screens and simultaneous navigation. Both use the same selected provider while keeping their existing browser profiles/sign-ins.
4. Close/sleep/disconnect that desktop mid-page and mid-download. Old transfers stop. Manual mode does not fall back; ranked mode advances only through its saved list, including server at its ranked position. Chat, inference, VNC, and ordinary machine control continue as applicable.
5. Resume the desktop: new epoch, fresh connections, no automatic resubmission of website mutations or byte replay. The owner can reload safely after inspecting the outcome.
6. Change from desktop A to B and then to server. All old sockets close before the new source is marked applied. No mixed egress survives the transition barrier.
7. Probe localhost, RFC1918, metadata, private IPv6, WebRTC/STUN, direct UDP/QUIC, secure DNS, proxy bypass rules, conflicting extensions/policies, and manually opened links. No supported managed-browser path escapes the selected route.
8. Confirm terminal HTTP, WebFetch, model providers, plugins, and VNC keep their existing paths and receive no injected proxy environment.
9. Test full-tunnel and split-tunnel VPNs, IPv4-only/dual-stack desktops, Wi-Fi changes, explicit-proxy-only corporate networks, trusted local HTTP, public HTTPS, and Tailscale remote access. Document unsupported cases rather than reporting false readiness.
10. Run through the packaged desktop app, not only Node fixtures, and through Chromium installed by the actual computer image.

### 12.4 Performance targets

On a controlled 100 Mbps path with added round-trip latency no greater than 50 ms, transfer a 256 MiB file with sustained throughput at least 70% of the same environment's single-stream encrypted relay baseline. The purpose is to catch buffering/credit regressions, not promise consumer-network throughput. Test 64 parallel streams with one stalled receiver, verify per-component retained buffer caps, and ensure control round trips remain below one second absent network congestion. Capture CPU and RSS separately from the 16 MiB queue budget; that budget is not total process memory.

Every drain/reset/reconnect scenario must leave zero orphan TCP sockets, intervals, stream-map entries, and queued buffers. Soak for one hour with repeated sleep/reconnect, toggling, and mixed small/large responses. Monitor desktop responsiveness and existing desktop performance budgets.

### 12.5 Definition of done

The feature is done when an owner can grant permission on a connected desktop, select it or configure an explicit ranked list, observe the effective exit from managed browsers, and disconnect/revoke it with only the configured fallback behavior; all supported browser paths and multiple screens follow that route; memory and lifecycle tests pass; old clients/VNC/machine operations still work; and the shipped product explains scope and recovery accurately.

## 13. Rollout and rollback

Introduce protocol/capability reporting and the stable broker behind a deployment feature gate, off by default. Enable server-mode broker testing first, then opt-in device routing. Existing deployments keep server mode and all local sharing grants start off. No A/B experiment may enable routing or local consent automatically.

Compatibility is negotiated across desktop, server, computer service, and already-running browser launch configuration. A compatible desktop alone is not sufficient. Unsupported peers return update_required; they never receive stream frames they cannot parse. New additive roster/event fields must not break old desktop/iOS parsers.

Operators may disable new selection while investigating without changing a persisted device selection to server mode. Emergency disabling of device routing closes the route and leaves browsers blocked until the owner explicitly chooses server. Disabling a UI or server feature gate must not remove proxy flags from still-running browser processes in a way that silently restores direct egress.

A downgrade to binaries that do not understand persisted device routing cannot preserve this guarantee. The update/rollback command must detect a non-server saved selection and stop with an actionable message. Require the owner to explicitly choose server mode first, or keep managed browsers stopped. Database backups alone do not make an old runtime safe to run under a device selection it cannot understand.

## 14. Follow-ups, deliberately separate

Per-bot source selection; destination allowlists in product settings; approved private/VPN hostname/CIDR access with local consent; desktop proxy/PAC chaining; mobile exit providers; UDP/WebRTC transport; device bandwidth schedules; peer-to-peer/WebRTC data channels; multi-server relays; isolated browser network namespaces; and user-installed third-party browser control.

None is required to ship public website traffic through an enrolled desktop. Private networking must be a separately reviewed capability because it exposes a different part of the owner's network.

## 15. Technical references

- [Chromium proxy behavior](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md): SOCKS5, WebSocket proxy selection, direct fallbacks, and implicit loopback bypass behavior. Validate the packaged version during implementation.
- [Chromium SOCKS configuration](https://www.chromium.org/developers/design-documents/network-stack/socks-proxy/): proxy-side destination resolution and resolver rules needed to prevent independent DNS traffic.
- [RFC 1928](https://www.rfc-editor.org/rfc/rfc1928): SOCKS5 negotiation, CONNECT request/reply, and address representations. This design intentionally omits BIND and UDP ASSOCIATE.
- [Node TCP sockets](https://nodejs.org/api/net.html): raw TCP dialing, half-close, write backpressure, timeouts, and explicit shutdown. Use the Node version embedded in packaged Electron when checking actual API support.
- [Grok Bot routing documentation](https://docs.x.ai/grok-bot/settings-and-notifications#route-traffic-through-your-desktop): comparison context only; OpenTeam's local consent and explicit manual/ranked policy are independent product decisions.
