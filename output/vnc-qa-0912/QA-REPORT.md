# VNC and shared computer QA — September 12, 2026

**Result: not ready for a clean sign-off.** Manual VNC use, shared input with a real agent, takeover enforcement, reconnect, and the real handoff completion flow work. Six input/recovery/usability findings remain. No product fixes were made in this QA task.

## What was tested

- Live `openteam` Docker stack, disposable bot **VNC QA Sep 12**, screen 101 / viewer port 6201, at 1280 × 800.
- Mouse and keyboard actions through CUA in native Chrome and the actual noVNC canvas. The input fixture records clicks, right-clicks, drag displacement, text, key modifiers, and scrolling.
- Real agent turns through the worker and computer runtime. Recorded provider/model: `openai-codex` / `gpt-5.5`, including computer-use child runs. These were model-chosen tool calls, not scripted substitutes for the agent.
- The actual desktop `BotScreen` component in a disposable integration harness. Its API adapter targets only the QA bot and calls the real server screen/handoff services. Both direct VNC and fallback frame/input modes were exercised.
- Focused tests: **31 passed initially; 34 passed after the workspace merge**, across 10 files. The additional tests concern viewer URL routing. See [current test output](./current-tests.log).

The workspace changed concurrently: initial HEAD was `0b878c0`; it merged to `e9212b2` at 03:42 EDT. The component checks and final test suite use `e9212b2`. The live computer container was not rebuilt or restarted by this task. The relevant key-action and noVNC code remains present in the final workspace.

## Confirmed findings

### 1. P1 — Computer key actions ignore the separate modifiers field

The live agent called `Computer` with `action: "key", key: "A", modifiers: "ctrl"`, then tried lowercase `a`. Both calls reported success but typed characters rather than selecting the field. Subsequent typing appended the target value to existing text. The agent recovered only by deleting characters individually and retyping.

[The key branch](../../apps/computer/src/screen/actions.ts#L74) passes only `input.key` to xdotool. The same function uses `input.modifiers` for click, drag, and scroll, but omits it for key actions. This breaks shortcuts expressed through the accepted `modifiers` field.

Evidence: [actual agent tool calls](./agent-evidence.json), especially 07:30:47 and 07:30:55 UTC. Fix by applying/normalizing modifiers to key actions and verifying both shortcut behavior and modifier release.

### 2. P1 — Fallback double-click sends three remote clicks

A single double-click emits one `click` request followed by a second request with `double: true`. The broker executes one plus two clicks. Repeating from the recorded count of 11 resulted in 14, rather than 13.

The cause is [the fallback click handler](../../apps/desktop/src/renderer/components/openteam/bot-screen.tsx#L417): it dispatches the first click immediately, then sends an additional pair for `event.detail > 1`.

Evidence: [request trace](./fallback-requests.json), [before](./fallback-before-double.png), [after](./fallback-after-double.png). The direct VNC path correctly handled single and double clicks.

### 3. P2 — Fallback cannot send Escape or function keys

With the fallback computer focused, F1 generated no remote action. Escape closed the viewer and generated no remote Escape action. With the direct VNC canvas focused, Escape stayed in the remote session instead.

[The fallback key handler](../../apps/desktop/src/renderer/components/openteam/bot-screen.tsx#L256) explicitly ignores Escape and has no function-key mapping. [The window handler](../../apps/desktop/src/renderer/components/openteam/bot-screen.tsx#L166) closes the viewer on Escape. Users cannot dismiss a remote dialog or reliably use keyboard-driven applications through fallback mode. During a handoff, closing also dismisses that handoff.

Evidence: fallback request trace contains neither F1 nor Escape; the actual component modal closed on Escape. Preserve remote key handling while the computer is focused and provide an explicit viewer-close action.

### 4. P2 — Reloading a connected VNC page loses authentication

Connect successfully, then reload that same viewer page. The canvas disappears and the page stays blank. Console error: `Viewer credential is missing`.

[The viewer bootstrap](../../docker/openteam-vnc.html#L35) reads the password from the fragment and removes the fragment from history. Reload therefore loses the in-memory credential and fails before connection handling starts. Opening a fresh authorized viewer URL works again.

Evidence: [reload failure screenshot](./reload-blank.png). Recovery should request fresh authorization from the parent or visibly direct the user to reopen the viewer, while keeping credentials out of the query string.

### 5. P2 — VNC authentication failures are invisible to the user

A deliberately incorrect password was rejected, as expected. The viewer set `data-connection-state="authentication-failed"` and logged the error, but displayed a completely blank dark screen with no explanation or recovery action.

[Connection state](../../docker/openteam-vnc.html#L51) only updates a data attribute; [security failure handling](../../docker/openteam-vnc.html#L88) stops reconnecting and logs to the console. Neither renders user feedback or informs the parent viewer. Display a useful failure state and a way to obtain a fresh connection.

### 6. P2 — Ordinary manual viewing has no takeover/pause control

The ordinary desktop viewer exposes only Close. It allows human and agent input concurrently but does not expose the working takeover lease or show who controls input. The handoff viewer does acquire and renew a lease.

This was visible in the actual component toolbar and confirmed in its control logic. I had to activate takeover through the QA service adapter to test protection during a running agent task. The agent then stopped correctly while manual input continued. Shared input can work between agent actions, but the user has no direct modal control to prevent a focus/mouse conflict.

## Passing checks

| Scenario | Evidence / result |
| --- | --- |
| Authenticated direct VNC connection | Live desktop displayed; credential removed from the visible URL. |
| Browser launch through desktop dock | Chromium opened through a manual VNC click. |
| ASCII typing, punctuation, multiline input | Text visible in the fixture; Enter created a second line. |
| Ctrl+A and Tab via direct VNC | Selected field text and moved focus correctly with browser keyboard events. |
| Single click, double-click, right-click | Correct direct-VNC click count; fixture logged right-click coordinates. |
| Drag and scroll | Fixture recorded drag displacement `229, 13` and scrolling. |
| Scaled coordinates | Direct and fallback clicks reached their intended fixture targets. |
| Two simultaneous viewers | A click in viewer two appeared immediately in viewer one; both remained usable. |
| Closing/reopening a viewer | Desktop and field state persisted. |
| Real agent computer use | Agent eventually set `AGENT-ROUND-1`, despite the modifier bug. |
| Human input alongside the running agent | Human wrote `MANUAL-WHILE-AGENT` while the agent performed timed clicks. |
| Human takeover enforcement | A later agent Computer call failed with the graphical input lease error; the child stopped. Manual input remained available. |
| Abandoned lease expiry | Later status returned `humanTakeover: false` after renewal ceased. |
| VNC transport reconnect | Terminated only the QA viewer's websockify connection worker, PID 8792. It reconnected as PID 9087, returned `connected`, and retained desktop state. |
| Fallback click, Ctrl+A, ASCII typing | Actual component and server services produced `FALLBACK` in the manual field. |
| Preview restoration | Closing the component modal restored the screen thumbnail. |
| Agent-requested handoff | Real agent emitted a computer-handoff message; actual component displayed Skip and “I'm done, continue.” |
| Handoff control and completion | Status confirmed `humanTakeover: true`; manual click changed count 14 → 15; completion closed the modal. |
| Exactly one agent resume | One completed `handoff_resume` run, no error. Agent used Screenshot and reported `Observed click count: 15`. Final status has `humanTakeover: false`, `agentInputPaused: false`. |

See [runtime evidence](./agent-evidence.json), [completed handoff](./handoff-completed.log), and [final screen status](./final-screen-status.log).

## Limits of this sign-off

- Full authenticated app navigation remains untested. The installed OpenBot app was version 0.1.0 against server 0.0.1 and blocked entry. The current development app requires user sign-in. A login request remains pending; no credentials or authentication settings were changed.
- The old app also owned port 8791 with an incompatible control token, causing agent Task calls to return `unauthorized`. Quitting that stale app and restarting the current development app restored the bridge. This was an environment conflict, separate from the six product findings.
- Clipboard, Unicode/IME, and native Mac shortcut behavior are **not signed off**. CUA native and browser text/clipboard paths behave differently on a canvas; some attempts failed or inserted partial text. The product has no explicit clipboard bridge in these viewers, but those attempts alone do not isolate every failure from the automation tool.
- No live iOS, physical touch, WAN/mobile-network, long-duration soak, full computer restart, or live Skip/dismiss branch test was performed. Mobile geometry/control serialization and handoff lifecycle were covered by the focused automated suite.
- Offline emulation did not disconnect an already-open WebSocket, so it was not counted as a reconnect pass. The separately verified socket-worker termination test supplies that evidence.
- The integration adapter adds subprocess overhead. Its latency was not treated as a product performance measurement.

## Artifacts and cleanup

The disposable bot and local input page remain for reproduction, idle with no active takeover. The test uses `/workspace/vnc-qa-0912/input-lab.html`. The helper source and screenshots are in this directory. The current development app remains available for sign-in. Temporary QA gateway/redirect servers are stopped at the end of the task. Existing concurrent workspace changes were left intact.

To reproduce the component harness, build `server-probe.ts` with Bun, copy the bundle to `/tmp/vnc-qa-server-probe.js` in `openteam-server-1`, run `component-gateway.ts`, and serve `harness.html` through the desktop Vite server. This is a disposable test adapter, not a production entry point.
