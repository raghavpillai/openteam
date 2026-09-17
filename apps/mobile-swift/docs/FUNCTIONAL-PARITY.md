# Functional parity and recovery audit

September 16, 2026. The Swift app uses the existing OpenTeam API and remains separately installable beside the RN app. The supplied screenshots govern the surrounding interface; OUR desktop artwork governs every robot. Missing reference states use native iOS navigation, forms, lists, alerts, selection controls and Quick Look.

## Implemented in this pass

| Flow | Behavior and recovery |
| --- | --- |
| Welcome, server, sign-in | Separate routes; normalized server/subpath validation; required and disabled auth modes; secure password fields and AutoFill; cancellation; missing token/incompatible server handling; distinct credential, forbidden, rate-limit, server and connectivity errors. No fabricated registration endpoint: accounts follow the existing server provisioning contract. |
| Session and account | Validate a replacement server before switching; scoped Keychain/cache; expired sessions preserve drafts/outbox for the same account; failed session revocation retains the account and settings sheet; successful sign-out clears its local data. |
| Conversations and profiles | Bot and group creation, 1–6 group members, bounded names/instructions, our twelve robot identities/colors, title/profile edits, duplicate/hide/pin/notification controls; failures retain edits. Native sheet dismissal precedes new conversation navigation. |
| Sidebar | Add/rename/reorder/delete custom sections, move conversations, explicit ordering, pinned/unassigned order and persistent settings. Failed save leaves editable state intact. |
| Memory | Load/search/retry; delete entry and confirmed clear-all; failed mutations preserve displayed entries. Returning from memory does not erase unsaved profile edits. |
| Routines | Create/edit/pause/run/history; validation and busy guards; revision-aware writes and explicit reload after conflicts. Event/composite schedules are preserved when editing unrelated fields. |
| Plugins | Catalog, installation/uninstallation, bot access, account naming, saved-secret keep/replace/clear, typed configuration, connection actions, OAuth launch/return refresh, tool policy/test confirmation, and plugin instructions. |
| Plugin workspace | Source create/edit/refresh/remove; private skills with enabled bots/support files; URL/ZIP/file-map import; draft JSON save/install/export/delete; package update preview/digest/rollback/export; HTTP/stdio custom MCP. Load, validation and operation errors stay next to their controls. |
| Chat and delivery | Native history/composer, persisted draft/outbox, attachment staging, stable delivery nonces, lost-ack reconciliation, retry/discard, unread retirement, search navigation, approvals, reactions and reply actions. Thread ancestry handles unordered replies, cycles and missing parents; successive/queued thread messages retain their context. |
| Rich content | Tables, headings/lists/quotes, KaTeX and Mermaid in a bundled offline document renderer; no network subresources; sanitized untrusted HTML and SVG; native inline/code views. |
| Media | Authenticated image thumbnails, authenticated file downloads, protected temporary storage, native Quick Look with persistent Done and Share. |
| Forms/cards | Prefill merged with entered values, production-compatible required/type/select validation, stable action nonces across retries, optional vault saving, secret clearing after accepted success, visible stale/rejected responses; computer, external draft/review and secure input actions use existing endpoints. |
| Computer | Authenticated screen, click/double/right-click, drag, touch/trackpad, native pinch/pan, type/key/scroll/open-app, serialized controls and lease heartbeat. Action errors survive frame refresh; failed typing retains text; completion has a stable client nonce and dismisses only after acceptance. |
| Voice and mentions | Native recorder with bounded recording duration and retained transcription retry/discard; selection-aware insertion when the draft is unchanged; recording also reachable from Attach with existing draft text. Plugin/skill and group bot/everyone suggestions use the composer contract. |
| Accessibility | Light/dark/system, accent, Dynamic Type, keyboard-safe layouts, explicit accessible labels/selected values and native alerts. Robot motion retains Reduce Motion/background behavior. |

## Verification method

`AuthFlowUITests`, `FunctionalFlowUITests` and `ContentFlowUITests` exercise actual simulator navigation, controls, retained input, failures and retries. The fixture checks persisted state and action receipts. Write requests are decoded against schemas imported directly from `packages/contracts/src/api`; form values are also checked by the production form validator. An inert fixture does not exercise a model, scheduler, OAuth provider or live desktop.

Failure injection covers credential rejection, 403, 429, 503, missing session headers, unreachable/incompatible servers, cancelled checks, expiry, failed sign-out, bot/profile creation, memory load/delete, routine creation/conflicts, plugin load/install/config, source/skill save, form submit and computer typing. Authentication and form screenshots include dark appearance; the auth suite traverses accessibility XXXL text. Compact smoke tests cover keyboard bounds, lost acknowledgment, offline reconnect, approvals, settings/search/create and successive offline thread replies.

The five-photo reply follow-up adds an inline (non-forked) delivery receipt assertion, offline leave/reopen, lost-ack deduplication and a tappable quote that scrolls back to an earlier original. Queued/failed messages now render the same quote as accepted messages. Cached history refresh failures caused by a network/server outage update connection state without opening an interrupting alert; explicit pagination, uncached history and non-transient errors still surface failures. Initial history positioning happens after system safe areas settle so the last bubble remains above the composer on compact iPhones. Visual keyboard captures assert an on-screen software keyboard, its bounds and a hittable space key rather than merely finding a keyboard in the accessibility tree.

The thread check also asserts the exact composed text before sending: a bidirectional SwiftUI selection binding was dropping characters and was replaced with a one-time UIKit selection read for voice insertion. The review preserves unmodified XCTest screenshot bytes and hashes. Each reference comparison records the source attachment, crop and test bundle. Historical RN images are labeled as historical; they are not presented as captures from this run. Native system keyboards, menu internals and status indicators vary by OS. No whole-app pixel-perfect or production acceptance claim is made.

## Remaining acceptance work

The follow-up [system QA](SYSTEM-QA.md) extends the fixture checks: 48 production integration tests passed against disposable PostgreSQL, and two desktop integration tests passed against real X11/Chromium. Swift created an actual five-minute routine, terminated, and reopened after a completed scheduled worker execution and parent delivery. The model boundary was deterministic. This pass also fixes production UUID routing, plain-text hold/reply metadata, native/desktop input ordering, stale screens, and ambiguous routine-run retries.

- Native APNs transport needs a server contract and signed device setup; the current push service accepts Expo tokens. Notification extension, badge lifecycle and push-driven cold links remain open.
- Extend the isolated production backend/worker/desktop checks to both clients with multiple accounts and live OAuth/services. Advanced plugin authoring/package/tool actions have endpoint/validation implementation but incomplete UI acceptance coverage.
- Signed iPhone checks: camera/photo permissions, real microphone/transcription interruptions, Keychain restart, backgrounding, rotation, VoiceOver traversal and sustained large-history memory/performance. The tested history uses 200 messages and an eager stack to avoid the prior layout loop.
- Search and cold deep links outside loaded history, every rich-card action/conflict, composite/event routine execution and multi-client reaction/read races need broader integration acceptance.

Keep the RN iOS app available during this acceptance period; Android continues to use RN.
