# Graphical computer implementation

Status: first graphical slice implemented and live-validated  
Last updated: 2026-08-25

> Runtime update: the desktop topology and validation below remain current, but the live agent host is now embedded Pi rather than Codex app-server. Each bot's Pi session and graphical display are stable identities inside the same computer service. See `27-pi-agent-runtime.md`.

## Outcome

OpenBot now provides a real Linux GUI for every bot. Creating a bot provisions its normal durable Pi session and workspace plus a stable 1280×800 virtual display. The agent can inspect and operate that display through `Screenshot` and `Computer`; the user sees the same pixels in Electron and can take over through noVNC.

The screens are separate work surfaces inside one Compose `computer` service. They are not separate computers or security boundaries. Every screen runs as the same non-root `openbot` OS user and sees the same persistent `/workspace` and computer home.

## Runtime shape

```text
computer container
├── embedded Pi host (all durable bot sessions)
├── shared /workspace
├── shared /home/openbot
└── ScreenBroker
    ├── bot A → Xvfb :100 → x11vnc 5900 → noVNC 6200
    │           ├── XFWM + xfdesktop + XFCE Panel
    │           ├── Chromium (bot A profile + live origin-state broker)
    │           ├── Thunar
    │           └── XFCE Terminal
    └── bot B → Xvfb :101 → x11vnc 5901 → noVNC 6201
                └── the same app set and shared mounts
```

Screen slots are persisted in `/home/openbot/.openbot/screens.json`. Chromium profiles live under `/home/openbot/.openbot/chromium/<botId>`. Archiving a bot stops the graphical process tree and releases its screen slot while retaining durable browser data.

## Reference-matched desktop

The supplied Grok Bot screenshots are consistent with a lightweight Debian-family XFCE desktop: Thunar is the file manager, XFCE Terminal supplies the terminal chrome, and the window decorations match XFWM. OpenBot therefore uses Debian 13 with an XFCE session shell rather than treating the screenshot as a custom operating system.

Every screen receives an isolated runtime copy of the checked-in XFCE configuration. It starts `xfsettingsd`, compositing XFWM, `xfdesktop`, and a transparent bottom XFCE Panel with centered Chromium, Thunar, and Terminal launchers. The image also ships a generated dark curved wallpaper, the stable `openbot@openbot` terminal identity, and app launchers that inherit the active bot workspace and durable Chromium profile. The launcher layout and native window arrangement reproduce the reference while preserving OpenBot's existing screen and filesystem model.

The computer container runs through `tini`, matching the reference image's visible init process and ensuring that browser, D-Bus, panel, and viewer descendants are reaped when a bot screen is archived or recreated.

Chromium's durable user data survives computer-container replacement. On desktop recreation OpenBot removes only its ephemeral `SingletonCookie`, `SingletonLock`, and `SingletonSocket` markers, preventing a former container hostname from falsely locking an otherwise healthy profile without deleting history, cookies, or settings.

## Agent tool surface

`Screenshot` takes no model-supplied screen identity. The runtime resolves the active Pi session to its active OpenBot run and captures that bot's root display as PNG. The tool returns text plus an image input so the model can reason over the pixels.

`Computer` accepts one bounded action:

- `move` with 1280×800-bounded coordinates;
- `click` with optional button and double-click;
- `type` with a length bound;
- `key` with a bounded safe key-name array;
- `scroll` with a bounded delta;
- `open_app` for `chromium`, `thunar`, or `terminal`;
- `wait` with a ten-second maximum.

The runtime binds every call to the active bot and current safe working directory. The model cannot pass a bot ID, display, executable, or arbitrary xdotool command. Each successful action returns a fresh screenshot.

## Human viewer and controls

The Electron inspector polls a real PNG thumbnail. Clicking it opens the selected bot's noVNC page in a full-screen overlay and immediately requests the human input lease in the same explicit action. It exposes:

- Chromium, Thunar, and terminal launch buttons;
- direct mouse and keyboard control after the preview click, with an acquiring state until the lease is confirmed;
- a renewable 45-second human input lease;
- explicit release on overlay close plus best-effort keepalive release on renderer close or component unmount;
- an emergency pause/resume switch for agent graphical input;
- reconnect/scaling through the noVNC client.

When the human lease is active, screenshots remain available but model-driven `Computer` input is rejected. Server-originated UI input is treated as human input and remains available. The viewer range is published only on `127.0.0.1:6200-6299`; raw VNC listens inside the container on localhost and the computer API requires the private control token.

## Live validation

The original 2026-08-24 graphical validation used the real Compose stack and the then-current authenticated Codex runtime. The Pi migration later revalidated authenticated `Screenshot` and `Computer` registration through the same host-bound computer API:

1. Bot A provisioned display `:100` and viewer `6200`; its initial XFCE Terminal opened in the bot workspace.
2. The public screen API launched Thunar and captured the resulting 1280×800 PNG.
3. Chromium opened, accepted structured type/key input, navigated to `https://example.com`, and rendered the page.
4. A live agent turn called `Screenshot`, `Computer { action: "open_app", app: "thunar" }`, `Screenshot`, and `SendMessage`; every GUI tool completed successfully.
5. Bot A created `/workspace/shared/gui-from-bot-a.txt` through its graphical terminal.
6. Bot B provisioned a distinct display `:101` and viewer `6201`, launched Thunar at `/workspace/shared`, and visibly showed Bot A's file.
7. With Bot A's human takeover active, a live model `Computer` call returned `success: false` and the exact reason `The user currently holds the graphical input lease`; `SendMessage` surfaced that result.
8. The noVNC HTML endpoint returned HTTP 200 and the server/computer health checks remained ready.
9. The XFCE replacement was rebuilt and visually revalidated with the reference-style wallpaper, centered transparent dock, native Thunar and Terminal windows, and Chromium. A container restart reproduced the desktop and reopened the same durable browser profile after safely discarding stale process-singleton markers.
10. Two separate Chromium profiles and displays synchronized a newly written cookie in both directions; deleting it from one browser removed it from the other and the computer authority.
11. After a computer-service restart, a fresh third bot browser received a durable test cookie from the encrypted authority; cleanup then verified no probe cookies remained in the canonical jar.
12. A human clicked the noVNC terminal, entered `id` through real key events, and received the expected non-root `openbot` identity; closing the whole client released the takeover lease.
13. Pause/resume, server restart recovery, computer restart recovery, and agent input before/after human takeover were revalidated in the complete v0 QA pass recorded in `23-interactive-desktop-and-qa.md`.

Contract tests cover valid and invalid action bounds and verify the declared tool descriptors. Pi session tests verify OpenBot custom tools are registered on durable session create/resume.

## Browser authority

Each bot still has an independent Chromium process, window, display, and writable profile. Every process exposes a loopback-only DevTools endpoint on an unexposed per-screen port. `BrowserBroker` reconciles cookies, local storage, IndexedDB, Cache Storage, and service-worker registrations through trusted CDP sessions. Logging in or changing durable origin state on one bot screen therefore becomes available to other running bot browsers without two processes writing one profile.

The canonical persistent cookie and origin-state store is AES-256-GCM encrypted under `/home/openbot/.openbot`; its random key is a separate mode-0600 file in the same private computer-home volume. Session cookies also synchronize in memory for the lifetime of the computer service. Session Storage and the remaining native profile state use stopped-profile publication. The UI describes browser sessions as computer-scoped while retaining profile separation as an implementation safety detail.

## Honest limitations

Browser state now uses two safe authority lanes. Cookies, local storage, IndexedDB, Cache Storage, and service-worker registrations reconcile live through the encrypted BrowserBroker. Session Storage, extensions and state, saved passwords/Web Data, preferences, bookmarks, history, and session tabs publish only after Chromium stops and hydrate before another bot profile launches. Client certificates use the shared computer-user NSS store. Browser-use target routing leases only agent-created tabs and popups; model-issued CDP calls cannot manage browser-wide targets or storage.

Additional production work includes authenticated remote access beyond localhost, encrypted VNC transport when leaving loopback, a more efficient streaming transport, GPU/audio/clipboard policy, and resource caps per screen. Chromium currently relies on the outer container isolation and runs with `--no-sandbox`; this is acceptable only for the local v0 boundary and must be revisited before untrusted remote deployment.
