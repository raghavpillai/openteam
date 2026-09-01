# Always-on computer: remaining work

Status: graphical shared computer and local host bridge shipped; production remote access and
device lifecycle remain open
Last audited: 2026-09-01

## Open work

### Public remote viewer and control

- Put frame, input, takeover, and viewer access behind HTTPS with a short-lived, bot/display-scoped
  authorization that cannot be reused for the rest of the owner API.
- Replace wildcard origin behavior with deployment-owned allowed origins, enforce request and input
  rate limits, and audit viewer/control sessions.
- Do not expose raw noVNC/WebSocket ports publicly. Terminate and authorize the stream at an
  OpenBot-owned gateway with reconnect, lease expiry, and emergency release behavior.
- Choose and validate a lower-overhead production transport for frame updates; retain noVNC as the
  local/self-hosted fallback until the replacement passes functional and visual parity.

### Computer runtime hardening

- Remove Chromium's `--no-sandbox` and wildcard `--remote-allow-origins=*` requirements before the
  computer is offered as an untrusted remote service.
- Enforce and test CPU, memory, process, storage, and log limits per installation and per bot screen.
- Prove recovery for display, browser, broker, and input-lease crashes without mixing bot displays
  or losing computer-scoped browser authority.

### Physical-host device lifecycle

The Electron bridge supports authenticated, approval-gated local reads and commands today. It is
not yet a general enrolled-device service.

- Add explicit enrollment, stable device identity, key rotation, revocation, and multi-device
  selection without accepting a model-invented machine ID.
- Define secure remote transport and reconnect/heartbeat behavior for a bridge that is not on the
  same host/network as the server.
- Add OS permission inventory and recovery for accessibility, screen recording, automation, and
  protected files.
- Provide an unambiguous menu-bar/tray state, one-click stop, update policy, and crash recovery so
  privileged automation is never left running invisibly after Electron exits.

## Acceptance gates

1. A leaked viewer URL or expired token cannot access another bot, display, owner API, or later
   session.
2. Public deployments expose no unauthenticated VNC/noVNC/CDP port and reject unapproved origins.
3. Reconnect, takeover expiry, emergency release, screen restart, and browser restart preserve the
   correct bot/display/browser authority.
4. Chromium runs with its sandbox enabled, and resource exhaustion in one screen cannot take down
   the installation.
5. Enrolled host devices can be listed, selected, rotated, revoked, stopped, and recovered; every
   consequential operation remains bound to the exact device and a current user approval.

## Current code to extend

- `apps/computer/src/screen-broker.ts`
- `apps/computer/src/browser-broker.ts`
- `apps/computer/src/browser-profile-authority.ts`
- `apps/server/src/services/screen-service.ts`
- `apps/desktop/src/main/host-bridge.ts`
- `apps/desktop/src/main/host-approval-queue.ts`
