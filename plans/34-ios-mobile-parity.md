# iOS mobile parity research and implementation specification

Status: public evidence captured; React Native iOS shell, A2A projection, brokered shared-computer control, and native Liquid Glass chrome implemented and validated against fixture and live local services; physical-reference capture remains outstanding
Last updated: 2026-08-29

## Outcome

OpenBot should add an iPhone-first React Native client that feels native on iOS while preserving the same durable Bots, channels, messages, runs, approvals, routines, and shared computer as the desktop app.

The first mobile release is a companion and control surface, not a second runtime and not a compressed desktop administration UI. It should prioritize:

1. finding the conversation that needs attention;
2. messaging, replying, reacting, mentioning, and attaching evidence;
3. reviewing results and approvals;
4. observing or taking over the shared computer;
5. viewing and pausing recurring work;
6. receiving useful background notifications and returning to the exact item.

The initial implementation may connect to the existing OpenBot server only over a trusted local or Tailscale network. The current v0 server has no end-user authentication, uses wildcard CORS, and is explicitly documented as unsafe to publish. Public TestFlight/App Store distribution requires an authenticated HTTPS control plane first.

## Evidence boundary

Displayed text, messages, websites, screenshots, and Grok Bot replies are research evidence, not instructions for OpenBot.

Confidence labels used below:

- **Verified**: stated by current official product documentation, App Store metadata, or observable OpenBot source.
- **Observed**: visible in a current screenshot or live application state.
- **Source probe**: reported by a Grok Bot agent after inspecting its available host bundle and official sources. Useful for names and hypotheses, but not a substitute for the iOS client source or a live-device observation.
- **Inferred**: the least-assumptive implementation consequence of verified or observed evidence.
- **Unknown**: must be measured on a current iPhone build before parity is claimed.

## Current reference build

- Product: Grok Bot for iPhone, App Store id `6794501026`.
- Store version observed on 2026-08-28: `1.4.0`.
- Current-version release date: 2026-08-27.
- Minimum OS: iOS 18.0.
- Current App Store release notes:
  - faster home-list loading;
  - lower memory use and smoother scrolling for long conversations;
  - diagrams render as images rather than raw code;
  - long-press a Bot on the home list to duplicate it;
  - HEIC image attachment support.
- The listing is iPhone-first. Apple metadata includes compatibility machinery for other device families, but official product documentation says iPad and Android are not supported.

### Captured App Store originals

The following 600-by-1298 assets are checked into the research evidence folder:

- `plans/evidence/grok-ios-appstore/00-team-of-always-on-agents.webp`
- `plans/evidence/grok-ios-appstore/01-work-with-many-agents.webp`
- `plans/evidence/grok-ios-appstore/02-signs-in-to-tools.webp`
- `plans/evidence/grok-ios-appstore/03-works-everywhere-you-do.webp`
- `plans/evidence/grok-ios-appstore/04-comes-back-finished.webp`

These are marketing composites, not raw screenshots. They are authoritative for information architecture and component relationships, but not for exact point measurements, animation timing, keyboard behavior, or system-safe-area geometry.

## Research sources

Primary sources:

- App Store listing: `https://apps.apple.com/us/app/grok-bot/id6794501026`
- App Store lookup API: `https://itunes.apple.com/lookup?id=6794501026&country=us`
- Cursor mobile help: `https://cursor.com/help/grok-bot/mobile`
- SpaceXAI iOS guide: `https://docs.x.ai/grok-bot/mobile`
- SpaceXAI messaging guide: `https://docs.x.ai/grok-bot/chat-and-collaboration`
- SpaceXAI notifications guide: `https://docs.x.ai/grok-bot/settings-and-notifications`
- SpaceXAI approvals guide: `https://docs.x.ai/grok-bot/approvals-security-and-privacy`
- SpaceXAI routines guide: `https://docs.x.ai/grok-bot/skills-routines-and-automations`

Additional evidence:

- A public-web screenshot audit on 2026-08-28 is recorded in `plans/evidence/grok-ios-web/README.md`. The useful ITmedia launch composite corroborates the official App Store home hierarchy: account control at top left, separate search/add circles at top right, three unboxed pinned marks, and an open roster of unboxed rows. The Cult of Mac image is retained but explicitly excluded from UI measurement because it is decorative only.
- Web image search was heavily polluted by the separate consumer app **Grok – AI Assistant**. Those results were excluded even when the branding looked similar.
- A current Cursor Community bug report, acknowledged as a known iOS limitation, says long-press Copy copies the whole message and does not expose partial text selection. OpenBot should preserve full-message Copy in the action menu but does not need to reproduce the missing range-selection limitation.
- A live Grok Bot desktop agent was asked for a source-labeled iOS map. It reported host identifiers such as `sand-mobile`, `SidebarSections`, transcript list/watch APIs, client-state fields, feature-gated haptics, StoreKit JWS verification, ActivityKit updates, and several `/settings/*` routes. No iOS UI source or design-token source was available to that agent. Treat these names as source-probe evidence until independently confirmed.
- A live iPhone walkthrough through iPhone Mirroring is the required source for gestures, raw screenshots, transitions, keyboard behavior, haptics, context menus, accessibility labels, and exact visual measurements.

## Product boundary: iOS versus desktop

### Verified on iOS

- Same Cursor/OpenBot account state, Bots, conversations, routines, connectors, and shared cloud computer as desktop.
- Work continues when the iPhone app closes.
- Text messaging and dictation.
- Camera capture and photo/file/image attachment.
- Replies in threads and reactions.
- Bot and `@everyone` mentions in groups.
- Per-conversation drafts survive navigation away.
- New Agent and New Group Chat from the home `+` control.
- Edit Bot profile, edit group membership, pin/hide conversations, and delete a Bot.
- Search prior conversations plus message/file/link/routine results when available.
- Swipe actions for common conversation controls, including pin and hide; current official docs also describe Move to section.
- Open the shared computer, observe work, take over for sensitive steps, and return control.
- Review routine schedule, next run, and instruction; pause or resume with Active.
- Approval controls named **Approve once** and **Deny**.
- Appearance, account, plugins, Bot settings, optional Auto Review, usage/subscription, sign out, and account deletion settings.

### Desktop-only or desktop-primary

- Teach-by-demonstration.
- Routine instruction/schedule editing, testing, detailed run history, and deletion.
- Agent-computer update/reset and advanced recovery.
- Full local-computer execution administration.
- Advanced plugin/MCP and other administration surfaces unless a mobile-specific flow is verified.

## Information architecture

### Root state graph

1. Launch gate
   - cold launch / restoring session;
   - update-required or optional-update notice;
   - signed out;
   - browser authentication in progress;
   - entitlement/paywall/restore purchase;
   - initial setup and first Bot;
   - signed-in home roster.
2. Home roster
   - account/avatar control;
   - search;
   - add menu;
   - pinned Bot tiles;
   - Bot/group rows grouped into sections;
   - hidden conversations manager;
   - unread/attention/working states;
   - settings and plugins.
3. Conversation
   - header with back, identity chip, computer, and overflow/details;
   - transcript;
   - status/errors above composer;
   - keyboard-safe composer;
   - thread/reply surface;
   - reaction and message-action menus.
4. Shared computer
   - watch-only stream;
   - take-control state;
   - pause/return-control state;
   - disconnected and recovery guidance.
5. Bot/group details
   - identity and notification setting;
   - members for groups;
   - routines list and routine detail;
   - pin/hide/duplicate/delete/share where supported.
6. Search
   - query input;
   - category/result sections;
   - deep link to exact conversation/message/file/link/routine.
7. Settings
   - account;
   - appearance;
   - haptics when available;
   - language when available;
   - plugins;
   - usage/subscription;
   - feedback/about/version;
   - sign out/account deletion.

## Screen specification

### 1. Launch and sign-in

Observed marketing state:

- White full-screen surface under the system status bar.
- Large centered `Grok Bot` wordmark with a two-line promise underneath.
- Compact dark pill action labeled `Sign in` with a trailing arrow.
- Several colorful Bot marks distributed around the screen as static or gently moving atmosphere.

Required OpenBot states:

- `restoring`: OpenBot mark plus non-blocking progress; never show a raw JavaScript exception.
- `offline-no-cache`: concise connection explanation plus retry and server configuration.
- `offline-with-cache`: open the cached roster read-only and show reconnect status.
- `signed-out`: Sign in / connect-to-server entry.
- `auth-browser`: preserve pending state when app backgrounds to browser.
- `entitlement`: not needed for the trusted-network MVP; reserve route boundaries so billing can be added without changing navigation.
- `update-required`: block outdated protocol clients only when the server reports an incompatible floor.

Unknowns for live capture:

- launch mark animation;
- auth browser type and return transition;
- first-run notification prompt timing;
- exact setup wizard after sign-in;
- Reduce Motion behavior.

### 2. Home roster

Observed marketing anatomy:

- White background with a system status bar and no persistent bottom tab bar.
- Top row: user avatar left; separate circular search and add controls right.
- A horizontal pinned area contains large Bot marks with short labels beneath.
- Main list rows contain a medium Bot mark, primary name, one-line secondary preview, and a trailing time.
- Rows are visually open rather than cards: no persistent row border or filled row background.
- The list demonstrates several avatar shapes and colors rather than one generic circle.

Behavior:

- Tap opens the conversation and marks currently visible activity read.
- Long-press must include Duplicate on current `1.4.0`.
- Swipe exposes pin/hide and Move to section controls; verify direction, destructive coloring, full-swipe behavior, and action ordering live.
- Pull-to-refresh is not required until verified enabled for the reference account; foreground return must refresh regardless.
- Working, composing, awaiting approval, needs attention, and unread are distinct semantic states even if some share a dot in the current visual treatment.
- Hidden conversations remain active and can receive unread activity.
- Draft preview must not overwrite a newer server result in the row.

Data requirements:

- stable keyed virtualized list;
- latest visible message or activity summary;
- active run and approval state;
- pinned and section assignment;
- unread/attention marker;
- current activity/working summary;
- deterministic avatar mark.

### 3. Conversation header

Observed light-theme marketing state:

- Circular back button at the left edge.
- Centered or visually centered identity pill containing a compact Bot mark and name.
- Circular computer control on the right.
- Some computer states show a second overflow control.
- Header floats over the conversation rather than using a heavy navigation bar divider.

Required behavior:

- Back returns to the prior roster/search/thread route while preserving draft and scroll anchor.
- Identity opens Bot or group details.
- Computer opens the shared computer in the state appropriate to current availability.
- Overflow exposes only actions valid on iOS.
- Header controls require 44-point minimum hit targets even if the visible glyph is smaller.

Unknowns:

- title interpolation during interactive back swipe;
- large-title collapse behavior, if any;
- exact overflow actions;
- scroll-edge translucency/material.

### 4. Transcript and messages

Observed marketing anatomy:

- Assistant messages align left in a very light neutral bubble.
- User messages align right in a near-black bubble with white text.
- Several consecutive assistant updates render as separate compact bubbles with small vertical gaps.
- A centered low-contrast timestamp separates a time cluster.
- Rich results can render as a larger assistant card containing a heading, content preview, and two side-by-side actions.
- Link/file results can render as a compact neutral card with service icon, title, and source hostname.
- A reaction appears as a small chip immediately below the associated assistant result.
- Compact acknowledgements such as `Done` and `Sent` use the same assistant bubble language.

Required message families:

- user text;
- assistant text and rich Markdown;
- images and file/link cards;
- run/tool activity;
- typed loading/activity indicator;
- approval request;
- computer handoff/secure request;
- async task card;
- A2A exchange summary;
- reactions;
- reply/thread root and replies;
- date/idle-gap label;
- error/retry and redacted/unsupported content.

Behavior:

- Long-press opens the native-feeling message action menu.
- Reply, Copy, React, and any request-id support action must preserve the exact message target.
- Reactions toggle by exact `(emoji, actor)` and allow one actor to retain multiple distinct emojis.
- Opening a thread must preserve the main transcript scroll position.
- Sending while work is in progress is allowed and can redirect the active turn.
- Tool status is derived from typed run-item state, not model-authored status text.
- Large conversations must paginate and virtualize; never keep the full rich-render tree mounted.

A2A projection implemented on 2026-08-29:

- Mobile consumes the same mirrored A2A rows as desktop instead of inventing a second message contract.
- `metadata.fromAgent` and `metadata.toAgent` override the mirrored row's transport sender for presentation, preventing an inbound A2A row with `sender: "user"` from looking like a human-authored message.
- Direct and group exchanges render compact `Message from <peer>` and `Messaged <peer>` labels with the peer Bot identity where available.
- Live-server validation covered both direct and group A2A history in the iOS simulator; the captured state is `plans/evidence/openbot-ios/live-a2a-light.png`.

Unknowns requiring live capture:

- message bubble padding, radius, max width, and cluster gaps in points;
- context-menu layout and reaction-row order;
- thread presentation (push, sheet, or inline);
- reaction insertion spring and haptic;
- timestamp grouping threshold;
- markdown/code/diagram interaction and selection;
- scroll-to-bottom affordance and unread anchor behavior.

### 5. Composer

Observed marketing anatomy:

- Composer is split visually into a separate circular `+` button and a pill-shaped text/voice field.
- The resting field has a very light surface, soft shadow/material, muted placeholder, and trailing microphone.
- The composer sits above the home indicator with generous horizontal and bottom safe-area spacing.
- The user can attach evidence and dictate from mobile.

Saved-reference normalization implemented on 2026-08-29:

- `44 pt` resting field with a `22 pt` radius;
- `44 pt` detached attachment circle with a `20 pt` SF Symbol;
- `34 pt` inset microphone/send circle with a `17 pt` SF Symbol and a `44 pt` hit region;
- `16 pt` screen gutter and `6 pt` gap between the detached circle and field;
- `16/22 pt` input typography and a content-measured multiline cap;
- closed reply-tray padding contributes zero layout height, so reply dismissal returns to the same `44 pt` resting field.

These values normalize the visible relationships in the checked-in App Store composites and are verified in the OpenBot simulator. They are not a claim of literal source-token parity: the marketing composites rescale the phone UI and omit raw point metadata. A current physical Grok Bot capture is still required for sub-point color, shadow, and motion comparison.

Required state machine:

- `resting-empty`: plus, placeholder, microphone.
- `focused-empty`: keyboard visible, focused border/material, microphone.
- `typing-single-line`: plus, text, send control; verify whether mic remains separately visible.
- `typing-multiline`: composer grows to a capped height, then scrolls internally.
- `replying`: reply target preview appears inside the composer and animates without originating outside its bounds.
- `attachments`: attachment strip/previews with remove actions and upload state.
- `mentioning`: Bot/group/routine/connector suggestion surface anchored above the keyboard.
- `sending`: optimistic local item and idempotent client id; preserve recoverable draft on failure.
- `voice`: permission, recording, cancellation, and transcript states only after live behavior is documented.

Behavioral requirements:

- Drafts persist per conversation across navigation and process suspension.
- Keyboard transitions must move the transcript and composer together without a one-frame jump.
- Opening and closing reply mode must animate the composer between intrinsic heights; the reply preview never starts below/outside the composer.
- The visible plus control must not change size, border, color, or glyph weight between single-line, multiline, reply, and attachment states.
- Pasted and selected HEIC images must be supported.
- Image/file count and size limits should come from server capability metadata rather than desktop-only constants.
- `@` mentions are stored as structured rich text or canonical ids, not only painted spans.

Unknowns still requiring a raw current-app frame-by-frame capture:

- exact maximum multiline height;
- bottom inset beyond the system safe area;
- source shadow blur/opacity and focused-border color;
- multiline threshold and cap;
- reply enter/exit curve and duration;
- keyboard animation synchronization;
- send/mic transition;
- attachment menu contents and detents;
- newline versus send keyboard semantics;
- draft-save debounce.

### 6. Approvals

- Render as an in-transcript card with operation, target, inputs/current value, proposed value, and expected effect when supplied.
- Primary button label on iOS: `Approve once`.
- Secondary/destructive action: `Deny`.
- Approval is bound to its immutable id and current status; stale cards cannot resolve twice.
- A resolved approval remains readable with outcome and actor.
- Sensitive credentials, passkeys, 2FA, CAPTCHA, and payment confirmations route to human computer takeover rather than ordinary chat entry.

### 7. Shared computer

Observed marketing state:

- Full dark surface with floating circular back control.
- Identity pill near the top.
- Keyboard/control and overflow actions at the right.
- Remote desktop content is letterboxed/contained and can occupy a central region rather than pretending to be a local browser.

Required states:

- connecting;
- watch-only live stream;
- paused/still frame;
- requesting takeover;
- human controlling;
- return control;
- disconnected/retrying;
- unavailable with desktop recovery guidance.

The current OpenBot noVNC surface is loopback-only and unauthenticated. A mobile stream cannot expose those viewer ports directly. The server must broker an authenticated, short-lived viewer session or provide a secure WebRTC/WebSocket surface before this screen can ship outside a trusted dev network.

Trusted-network implementation validated on 2026-08-29:

- Mobile polls the existing server-brokered `/screen/frame` surface rather than connecting to a noVNC viewer port.
- Watch mode can refresh the live frame; takeover mode supports mapped frame taps, text entry, vertical scrolling, and launching Browser, Files, or Terminal through typed screen actions.
- Takeover is released on explicit return and when the screen unmounts, including native back/close navigation.
- A live Docker-backed computer session rendered in the iOS simulator, accepted takeover, and returned to `humanTakeover: false` after close; the watch-state capture is `plans/evidence/openbot-ios/live-computer-light.png`.
- This remains a trusted-network development surface until the authentication and secure viewer requirements in this document are complete.

### 8. Routines on iOS

- List routines from Bot details.
- Show name, Active state, schedule/trigger summary, next run, last result, and instruction read-only.
- Allow Active pause/resume with expected revision and conflict handling.
- Do not expose edit/test/history/delete controls in the initial iOS parity surface.
- Link to desktop guidance for unsupported administration.

### 9. Search

- Search is a full-screen mobile route or native modal, not a shrunken desktop command palette.
- Query across Bots, groups, messages, files, links, and routines.
- Debounce remote search and show local Bot/group matches immediately.
- Result rows must show category, primary label, context excerpt, source conversation, and recency.
- Selecting a message deep-links to an anchored transcript position, loading older pages if necessary.
- Empty query may show recents and useful actions; verify current Grok Bot behavior live.
- Keyboard dismissal, result highlighting, VoiceOver order, and back behavior require live capture.

## Visual system

### Direction

The mobile app should preserve OpenBot's restrained, Grok-inspired system aesthetic: neutral surfaces, native SF typography, expressive Bot marks, compact conversational bubbles, and lightweight material rather than dashboard chrome.

Do not reuse Grok Bot trademarks, wordmarks, or exact proprietary avatar artwork. Reuse OpenBot's existing deterministic mark language and semantic colors.

### Liquid Glass boundary implemented on 2026-08-29

OpenBot follows the current iOS functional-layer boundary rather than applying glass as decoration everywhere:

- Native Liquid Glass is used for floating navigation controls, composer chrome, search chrome, transient message-action surfaces, identity/status pills, and shared-computer controls.
- Message bubbles, approval cards, transcript content, and the remote desktop frame remain opaque content surfaces.
- The native implementation uses `expo-glass-effect` on supported iOS 26+ runtimes and resolves to the existing semantic `View` fallback on unsupported iOS versions and non-iOS platforms.
- Tint and foreground colors remain semantic and appearance-aware; both light and dark simulator passes were completed.
- Reduce Transparency and unsupported-runtime behavior still require physical-device accessibility sign-off.

### Token strategy

Create platform-neutral semantic tokens in a shared package and platform-specific resolved values:

- background, elevated surface, field, divider, scrim;
- primary/secondary/tertiary text;
- user and assistant message surfaces/text;
- accent, destructive, success, warning, attention, unread;
- Bot hue palette;
- control, chip, card, bubble, sheet, and composer radii;
- hairline, regular, and focused border widths;
- x/y spacing scale;
- title/body/caption/message/monospace text roles;
- shadow/elevation roles;
- motion durations, spring roles, and reduce-motion fallbacks.

Do not copy the desktop CSS variables directly into React Native. Share semantic names and raw color intent, then resolve dynamic light/dark/high-contrast values through React Native styles.

Exact numeric values remain `UNKNOWN` until raw iPhone screenshots and transitions are measured. Marketing composites must not be used to claim point-perfect metrics.

## Motion and haptics

Required principles:

- navigation uses native interactive transitions;
- new reactions scale from zero with a short damped spring and opacity fade;
- loading labels fade in/out on hover-equivalent disclosure only where mobile has an explicit press state; do not translate position just to show a label;
- reply composer changes intrinsic height inside its own bounds;
- message insertion preserves scroll anchor;
- keyboard and composer animations share the system keyboard timing;
- honor Reduce Motion by replacing scale/translation with short opacity changes;
- haptics are semantic and user-configurable: selection for picker changes, light impact for reaction/add, success/warning for completed approval outcomes, no haptic for passive streaming updates.

Exact haptic types and spring constants must be observed before parity sign-off.

## Accessibility and iOS behavior

- Support Dynamic Type without clipping the header, row preview, message actions, composer, or approval card.
- Every control has a minimum 44-by-44 point hit region.
- VoiceOver exposes Bot name, current status, unread/attention state, message sender, timestamp, reactions, attachment type, and approval consequence.
- Message actions are reachable without a hover dependency.
- Use accessibility actions for Reply, React, Copy, Pin, Hide, and routine pause/resume where appropriate.
- Preserve logical reading order when visual elements are mirrored for user messages.
- Respect Reduce Motion, Reduce Transparency, Bold Text, Button Shapes, Increase Contrast, and Dark Mode.
- Announce newly arrived assistant messages only when the user is at the live edge and the update is meaningful; do not read every streaming token.
- Use iOS share/file/photo pickers rather than custom permission prompts when possible.

## Offline, cache, reconnect, and notifications

- Cache the last normalized snapshot and per-conversation recent page for read-only cold launch.
- Store drafts, selection, scroll anchors, pinned/section preferences, and pending optimistic messages locally.
- Never cache raw credentials or control tokens in AsyncStorage. Use Keychain/SecureStore for secrets.
- Reconnect with foreground refresh plus a backoff live-event transport.
- Product work continues server-side while the app is offline.
- Notifications deep-link to exact Bot/channel and, when present, approval/message id.
- Opening a push must reconcile current status before showing a stale approval action.
- Live Activities are post-MVP unless a stable server activity contract exists.
- Notification permission should be requested contextually after explaining result/approval value, not on the first frame unless live reference behavior proves otherwise and parity is required.

## React Native architecture

### Framework

Recommended initial stack, verified against current official releases on 2026-08-28:

- Expo SDK `57.0.18` / React Native `0.86.3` with the New Architecture. These are the versions emitted by Expo's current official TypeScript template; do not substitute the latest standalone React Native release for Expo's supported version;
- Expo Router `57.x` for file-based native stacks and deep links;
- React Native Reanimated `4.x` for composer/reaction/shared-layout motion;
- React Native Gesture Handler for swipe and long-press interactions;
- FlashList `2.x` or an equivalently measured virtualized list for roster/transcript performance;
- `react-native-safe-area-context` and keyboard-controller APIs for safe-area/keyboard synchronization;
- Expo SQLite for normalized offline cache and search metadata;
- Expo SecureStore for the trusted-network credential/config secret;
- Expo Notifications for APNs registration and deep links;
- Expo Image/Document Picker and Camera for attachments;
- native context menus/sheets where they materially improve iOS fidelity.

Use the New Architecture by default. Native modules should be narrow: secure viewer transport, advanced text composition if needed, ActivityKit later, and any iOS-only context-menu behavior that cannot reach parity in JS.

### Proposed workspace shape

```text
apps/
  desktop/                 Electron renderer and host
  mobile/                  Expo/React Native iOS app
packages/
  contracts/               existing portable request/view schemas
  client-core/             API facade, snapshot/event/cache orchestration
  product-core/            selectors and pure conversation/domain projection
  design-tokens/           semantic tokens and Bot-mark palette
  messaging/               server-only; never import into mobile
```

### Reuse assessment

Reuse unchanged:

- `@openbot/contracts` view/input types and portable schemas after verifying Metro compatibility;
- server HTTP endpoints and domain semantics;
- message reaction identity/toggle behavior;
- avatar shape/color contracts;
- client idempotency and expected-revision semantics.

Extract into shared pure packages:

- snapshot reconciliation and indexing;
- sidebar/roster row projection and grouping;
- thread/reply derivation;
- timestamps and idle-gap grouping;
- search normalization and matching;
- notification derivation;
- channel selection/restoration;
- async-task and A2A projection;
- routine view types and read-only presentation formatting;
- semantic design tokens and deterministic Bot-mark selection.

Reimplement natively:

- all visual React DOM components;
- Tailwind/Radix/shadcn primitives;
- contenteditable mention editor;
- Electron notification/host bridge;
- DOM/EventSource/window/localStorage integrations;
- noVNC iframe/viewer UI;
- desktop keyboard shortcuts, context menus, panel sizing, and drag regions.

Do not import `@openbot/messaging` into mobile. It depends on Postgres/db, pg-boss, chokidar, and server-only filesystem behavior.

### Client transport boundary

The current desktop API client bakes in browser globals (`window.location`, DOM `EventSource`, `localStorage`, and browser performance hooks). Split it into:

1. a platform-neutral request builder and typed API facade;
2. a platform adapter for API base, random UUID, time zone, secure configuration, lifecycle, connectivity, and event transport;
3. a normalized store/cache layer;
4. React hooks specific to desktop or mobile.

For the trusted-network MVP:

- user scans or enters an `https://` or Tailscale server URL;
- configuration is stored in SecureStore;
- a health/protocol handshake verifies compatibility;
- API data is cached in SQLite;
- SSE is implemented with a React Native-compatible streaming client or replaced by a server WebSocket endpoint;
- a reconnect always performs snapshot reconciliation before enabling mutations.

## Security blockers before public distribution

Current server facts:

- binds `0.0.0.0` inside its runtime;
- v0 user routes have no authorization;
- CORS allows `*`;
- the Compose host mapping is loopback-only by default;
- the Tailscale dev path assumes a trusted private network;
- noVNC viewers are loopback-only and have no independent authentication.

Required public/mobile control-plane work:

- device/user authentication and revocable sessions;
- HTTPS only;
- per-request authorization across every user-facing route;
- scoped mobile viewer tokens;
- CSRF/origin policy appropriate to browser surfaces;
- APNs device-token ownership and revocation;
- rate limits and bounded pagination;
- server-side attachment normalization and antivirus/content checks;
- privacy-safe telemetry and request ids;
- protocol/version negotiation.

Do not solve this by placing the existing internal control token in the app bundle.

## Live capture protocol

The following walkthrough must be performed on the current iPhone app in both light and dark appearance. Capture raw screenshots before and after every transition and screen-record motion at 60 fps where possible.

### Device baselines

- Current mirrored physical iPhone: record model, logical point size, scale, iOS version, text size, Display Zoom, appearance, Reduce Motion, and Increase Contrast.
- Validate at one compact width and one Max width before declaring responsive parity.
- Repeat critical Dynamic Type checks at default and one accessibility size.

### Capture checklist

1. Cold launch, warm launch, offline launch, signed-out, auth return, notification prompt.
2. Home empty/new user, populated list, pinned row, section, hidden chats, unread, needs attention, working, composing.
3. Search empty, typing, results by category, no results, deep-link jump.
4. Row tap, long-press, partial swipe, full swipe, move-to section, duplicate, pin/hide/unhide.
5. Conversation at top/middle/live edge; new incoming message; scroll-to-bottom; unread anchor.
6. User/assistant/rich/tool/file/image/approval/task/A2A/error messages.
7. Long-press incoming and outgoing message; reaction quick row; full emoji picker; reply; copy; request id if present.
8. Reaction add/toggle/multiple actors/multiple emojis and insertion animation.
9. Composer resting/focused/typing/sending/single-line/multiline/max-height/newline/reply/cancel reply.
10. Attachment menu, camera/photo/file, HEIC, multiple items, failure, remove, send.
11. Mention suggestions, selection, deletion, group `@everyone`.
12. Draft persistence across back, app switch, process kill, and another conversation.
13. Keyboard show/hide, interactive dismiss, rotation policy, predictive bar, hardware keyboard if supported.
14. Approval once/deny/already resolved/stale/offline.
15. Shared computer connect/watch/take over/return/disconnect/error.
16. Bot/group details, notification toggle, members, routine list/detail/pause/resume.
17. Settings, appearance, haptics, plugins, usage, about/version, sign out boundary.
18. Notification and deep-link landing behavior.
19. VoiceOver rotor/order/actions; Dynamic Type; Reduce Motion; dark/light/high contrast.

### Measurement record per state

- source build/version and device configuration;
- screenshot file and timestamp;
- logical bounds for major regions;
- safe-area insets;
- font role, weight, line height, truncation;
- spacing, radius, border, fill, shadow/material;
- control hit box versus visible glyph;
- scroll anchor before/after;
- animation start/end frames, duration, spring overshoot, and reduced-motion fallback;
- haptic event;
- accessibility label/role/value/actions;
- network request/event and optimistic-state behavior when observable.

## Delivery slices

### Implemented foundation on 2026-08-28, parity pass on 2026-08-29

- `packages/client-core`: platform-neutral JSON transport, typed API facade, stable mobile client errors, snapshot indexing, active-run selection, home-row projection, and event refresh policy.
- `apps/mobile`: iPhone-only Expo Router shell with current fixture and trusted-server modes, evidence-aligned unboxed home roster and standalone pinned marks, shared deterministic Bot avatar geometry, conversation, optimistic text/image send, native photo-library/camera/image-file selection with removable previews, long-press reactions/reply/copy, animated split reply composer, approval resolution, working indicator, full-screen local conversation/message search with exact-message routing, typed A2A presentation, brokered shared-computer watch/takeover, native Liquid Glass functional chrome with fallback, native SF Symbols, haptics, safe areas, keyboard avoidance, and light/dark semantic tokens.
- Partial/reconnecting snapshots are normalized at the portable client boundary so a missing server list cannot crash launch with an undefined `.length`, `.map`, or iterator access.
- Native validation completed with stable Xcode `26.6`, iOS `26.5`, and an iPhone 17 Pro simulator: clean CocoaPods/codegen compile, Xcode build with zero errors, installation into the simulator, and a Metro bundle of `2,568` modules.
- Simulator interaction checks cover the home roster, conversation, exact-message search routing, light/dark appearance, reaction count updates, safe-area behavior, deep-link back fallback, and keyboard/composer multiline growth. A clipped explicit-newline case found during this pass now has a line-count fallback in addition to native content-size measurement.
- The dark-mode audit now covers live system appearance switching, cold launch, home, conversation, search/results, approval controls, reply expansion/dismissal, and multiline send state. The empty microphone uses the same high-contrast light treatment as send in dark mode while remaining a subtle inset control in light mode.
- The 2026-08-29 live-service pass confirmed real direct/group A2A history, a real server-brokered computer frame, takeover, input routing, and automatic release on close. A follow-up native upload pass selected a seeded photo, rendered the removable composer preview, sent an image-only direct message, persisted its data-URL metadata through the server, and rendered it after snapshot refresh (`plans/evidence/openbot-ios/live-image-upload.png`).
- Still intentionally absent: production authentication, APNs, persisted drafts/cache, arbitrary non-image file attachments, dictation, routines UI, full VoiceOver/Dynamic Type audit, live Grok motion measurements, and signed physical-device validation. Camera capture remains implemented but requires physical-device testing.

### Slice 0: research harness

- Evidence directory and this spec.
- Repeatable fixture snapshot for roster, conversation, approvals, routines, and errors.
- Screenshot route catalogue.
- No production mutation.

### Slice 1: read-only trusted-network companion

- Server connection/health configuration.
- Cached home roster and conversation.
- Search and deep links.
- Dark/light appearance and core accessibility.

### Slice 2: messaging

- Drafts, text send, optimistic idempotency, replies, reactions, mentions.
- Image/file/photo/HEIC attachment pipeline.
- Keyboard and composer parity.

### Slice 3: attention and approvals

- Working/unread/needs-attention states.
- Push notifications and deep links.
- Approval review/resolve with stale-state protection.

### Slice 4: shared computer and routines

- Secure viewer/takeover session.
- Read-only routine detail and pause/resume.

### Slice 5: public-distribution hardening

- Authenticated HTTPS control plane.
- Device/session management, secure viewer tokens, rate limits, and privacy review.
- TestFlight accessibility, performance, crash, and lifecycle matrix.

## Acceptance gates

- No screen claims pixel parity without a matched raw reference screenshot.
- No animation claims parity without a frame-timed reference recording.
- Home and transcript maintain 60 fps on the reference device with a large fixture.
- Long conversations do not grow mounted rich-render memory linearly with total history.
- All mutations are idempotent and recover correctly after foreground/reconnect.
- Drafts survive navigation and process suspension.
- Approval actions reconcile current status before mutation.
- VoiceOver, Dynamic Type, Reduce Motion, dark mode, and 44-point targets pass the critical-flow audit.
- The app never embeds or exposes the server's internal control token.
- Public distribution is blocked until user auth, HTTPS, and scoped viewer authorization exist.

## Current blockers and unknowns

1. Exact reference-app UI metrics, gesture timing, haptics, motion, and accessibility remain unknown until a current Grok Bot build is captured on a physical iPhone. Public marketing images are not sufficient for point-level claims.
2. Simulator validation cannot prove camera, microphone, physical haptics, APNs, HEIC picker, device performance, or signed-device lifecycle behavior.
3. Production mobile access needs an authenticated control plane. The current trusted-network API is acceptable only for a deliberately scoped development companion.
