# Question lifecycle in Grok Bot and OpenTeam

Ordinary question cards stop being actionable when the user sends another message. The message remains normal conversation: it can answer the question in context or change the subject. Only submitting the card records a structured answer. OpenTeam applies this rule durably on the server and projects it immediately on desktop and iOS.

## Native Grok Bot observations

The macOS Grok Bot 1.0.1 app was exercised on November 13, 2026 in the isolated bot `Question Lifecycle QA Nov13`. All choices were synthetic; the bot was instructed not to use connectors, send external messages, run commands, create files, save memories, or delegate.

| Interaction | Observed result |
| --- | --- |
| Ignore a Red/Blue card and ask what 2 + 2 is | The card immediately becomes Dismissed, loses its buttons, and the composer returns to its normal prompt. The bot answers 4. |
| Leave an unanswered Circle/Square card, switch to another chat, and return | The card remains actionable and the question composer hint remains. The earlier dismissed card stays dismissed. |
| Send another unrelated message after returning | The Circle/Square card immediately becomes Dismissed. |
| Ask to revisit the earlier color question | A fresh card appears. The original remains dismissed. Selecting Blue on the fresh card displays Your answer: Blue. |
| Type Blue into the main composer while a Red/Blue card is open, then press Enter | Blue appears as a normal user message. The old card becomes Dismissed, without a structured answer. The bot replies that Blue was selected based on the conversation. |
| Select Alpha and draft Gamma in a multi-select card, then send an unrelated chat message | The card becomes Dismissed. The selected option and unfinished custom answer are not submitted. |
| Type Skip that sample choice | The card becomes Dismissed as the normal message is sent. |
| Inspect the sidebar while a question is pending | A blue unread dot appears; no orange star is shown. The composer says Type your answer, or talk about something else. |

The final synthetic choice remained actionable for roughly eleven minutes before the final skip message. This establishes neither a days-long lifetime nor a universal age timeout.

The tested single-choice card's context menu offered reply, copy and request-ID actions. No separate dismiss control appeared in that card's accessibility tree or screenshot. The installed renderer nevertheless has an explicit dismissal path. OpenTeam retains its existing explicit Dismiss control.

### Unselected chats and notifications (November 14 follow-up)

With `Draft Timing Parity A` selected, the research bot's pending question appeared in the sidebar as `QUESTION PREVIEW TEST: Which sample color?`, with the usual blue unread dot. Its help text (`Choose a sample for this test.`) and Red/Blue choices appeared inside the card but not in the sidebar preview. There was no star, checklist glyph, or other question-specific avatar/preview marker. A second Cat/Dog question produced the same prompt-only sidebar preview. Reopening that question cleared the unread dot while leaving its choices actionable.

The installed renderer's `gH` returns the ordinary widget prompt as its message summary. The installed Electron main bundle has separate notification formatting (`uUt`) and focus gating (`Hyr`, `Lgr`, `Ugr`). In the desktop chat route, focus suppresses the conversation on screen; a different conversation and an unfocused app remain eligible, subject to read state, notification preferences, throttling and deduplication. Notifications use Electron's native notification API with a title and body, and clicking opens the conversation/message. There is no question-specific icon or answer-button configuration in that constructor.

For ordinary message notifications, the title is the bot's display name and the body comes from the latest preview, with whitespace normalized and a 140-character limit. Its preview formatter supports `widget_prompt` as well as `widget_options` and `widget_answered` payloads. Approvals that set `awaitingUserResponse` have a separate needs-input notification path and copy.

macOS initially had Grok Bot notifications disabled, with temporary banners selected underneath the disabled setting. The user's permission was obtained before temporarily enabling notifications for the live test. The `BANNER TEST: Which sample animal?` question was generated three seconds after the prompt while Grok was hidden; inspecting the hidden window initially returned stale state. No native banner screenshot was captured. macOS also had notifications while mirroring/sharing set to Notifications Off; this global setting was left unchanged. The app's notification permission was restored to off and verified in System Settings. The synthetic question was subsequently dismissed by a stop message, and the bot acknowledged `Test stopped.`

The exact notification payload was subsequently recovered by reading macOS's notification history database in read-only mode, filtering to `com.anysphere.sand` and the isolated research bot. The stored notification had `presented = 0`, consistent with no visible banner during this test. Its actual text was:

| Field | Grok Bot notification |
| --- | --- |
| Title | `Question Lifecycle QA Nov13` |
| Body | `BANNER TEST: Which sample animal?` |

The body contains only the question prompt: no “asked a question” prefix, help text, or Cat/Dog options. The following ordinary response used the same bot-name title and `Test stopped.` as its body. OpenTeam's title/body composition is checked against the actual question payload in `packages/messaging/test/notification-body.test.ts`. The text is verified; exact native banner pixels remain unverified.

### Additional interaction tests (November 14)

The same isolated bot was exercised with fresh `PARITY-Q6` through `PARITY-Q9` cards. No connectors, commands, external messages, files, memories, or delegation were requested or used.

| Case | Grok result | OpenTeam result/change |
| --- | --- | --- |
| Select Alpha, draft Gamma, navigate to a different chat and back | Both unfinished inputs remain; the card is still actionable | Desktop session drafts and iOS channel drafts already preserve navigation state |
| Reload the desktop app with those unfinished inputs | The question remains open; the selection and custom text reset | Matches OpenTeam desktop's session-only question draft store |
| Press the next letter after the option shortcuts | Focuses the inline custom answer field | Added this desktop shortcut and the Something else placeholder |
| Press Done on a multi-select card with nothing selected or typed | Card becomes Dismissed, with no structured answer; no new bot reply appeared before the next user message | Added always-available Done on desktop/iOS; an empty Done uses explicit dismissal |
| Submit Alpha plus custom Gamma | Your answer displays Alpha and Gamma, and the bot acknowledges both | Existing combined answer construction matches; Electron regression covers it |
| Press Enter in an empty single-choice custom field | Card remains open and no answer is submitted | Existing empty-answer guard matches |
| Send later normal messages after structured answers | Earlier Your answer receipts remain resolved | Covered by both client projections and history tests |
| Confirm text during IME composition | Installed widget code explicitly ignores composing Enter events | Added the missing desktop guard; regression verifies no submission |

The empty Done dismissal is deliberately distinct from Enter in an empty custom field, which does nothing. Installed `chunk-widget-Dr8msTuD.js` corroborates both paths: the Done handler dismisses when its assembled answer is empty, while the custom-field Enter handler ignores empty answers and IME composition.

An additional OpenTeam update-ordering test exposed a gap independent of the native experiments: a newly published question could render alongside its still-pending predecessor until the predecessor's canonical update arrived. Desktop and iOS projections now retire the predecessor immediately in the same scope, without mutating cached rows. The regression failed before this fix and passes afterward; the server already persisted the same invariant.

Remaining parity limits are explicit. Exact macOS banner pixels, genuine multi-day question aging, simultaneous questions from independent Grok background work, and interactions across two real Grok clients have not been verified. Grok's dismissed cards retain faded option text; OpenTeam desktop uses a compact dismissed presentation, while iOS retains faded options. iOS persists question drafts across app launches, whereas the tested Grok desktop reload clears them; Grok's iOS behavior was not tested. These are not evidence for inventing an age timeout or changing approval lifetimes.

## Installed client behavior

Read-only inspection of the installed `app.asar` agrees with the native observations. In the renderer bundle `index.eager-app-C1EubAxZ.js`, `WH` computes historical dismissed widgets by scanning backward across real user-message boundaries and settled widgets. `KJt` selects the current question, stopping at those same boundaries. `RR` distinguishes active, resolved and dismissed presentation. Synthetic system notices are excluded from ordinary user boundaries by `HJt`.

A card submission goes through `respondToWidget`; explicit dismissal uses `dismissWidget`. Normal composer sends go through `sendPrompt`. The renderer also contains an opportunistic answer-settlement path with per-card deduplication; the live typed-Blue test did not display a structured answer on its card. These findings describe the shipped client, not the private server implementation.

## Different request lifetimes

Question cards are distinct from approvals, drafts, credentials, forms and computer handoffs. Grok's [troubleshooting documentation](https://docs.x.ai/grok-bot/troubleshooting#an-approval-expired-or-is-blocked) says approvals from background work expire after about 30 minutes, while approvals from a chat the user is participating in wait for the user. The [November 6 changelog](https://x.ai/changelog/bot) says abandoned computer handoffs stop showing Waiting for you after 24 hours. Neither rule establishes an age timeout for ordinary questions.

## OpenTeam implementation

Every newly accepted normal message retires outstanding questions in that conversation scope, including typed answers, attachments and replies. Retries of an already accepted message do not dismiss a question published afterward. Answering a retired question from a stale client returns the authoritative card without waking a bot.

Question publication, normal messages, answers and dismissals share a per-channel transaction lock. Publication retires an earlier open question in the same scope, giving OpenTeam one active question per scope. This is an OpenTeam invariant; concurrent background Grok questions were not exercised. Main conversations and fork roots have independent scopes. A fresh card never revives its predecessor.

The database preserves `respondedValue` for explicit card answers. Dismissal preserves the question and records `widgetDismissalReason`: `moved-on`, `dismissed`, or `superseded`. Model context distinguishes moving on from an explicit decline: a normal message may supply the answer, while silence and skipped questions never grant permission. Dismissal does not generate a separate conversational wake.

Desktop and iOS derive the same historical presentation without rewriting cached messages. Optimistic sends close questions immediately; removing a definitely rejected send can restore the still-pending card. Server settlement prevents history paging, relaunches and reconnects from reactivating retired questions. Structured answers remain visible after later messages.

iOS custom answers live inside the card and have an explicit Submit button, separate from the normal composer. Both clients show the contextual question hint. Ordinary questions no longer create iOS's persistent orange star; requests such as pending drafts and credentials retain their independent attention state.

The November 14 follow-up also removes iOS's question-preview checklist icon and appended help/options. Shared desktop/server summaries and iOS previews prefer the question prompt, with ordinary content as a malformed-card fallback. Notification bodies use the same shared summary. At the user's request, OpenTeam suppresses all banners while its window is focused, including other chats; banners remain eligible in the background. This intentionally differs from Grok's per-conversation focus gating. Existing read reconciliation, throttling and click routing remain in force.

The opt-in `dismissOnMoveOn` tool field and iOS's composer-to-widget answer path were removed. There is no compatibility mode or data backfill. Existing unanswered cards settle on the next accepted message; presentation also respects later messages already in loaded history. No new age-based expiration is inferred for ordinary questions.

## Validation

The isolated PostgreSQL tests cover normal typed replies, rejected stale answers, idempotent message retries, explicit answers and dismissals, fresh publication, fork isolation and eight answer-versus-send races. The wider direct-message, attachment and group-supersession checks pass as well.

All 301 Swift core tests pass. The Xcode 27.3 simulator build passes, and a native UI test on a fresh iOS 27.1 Duo simulator verifies that an unfinished multi-select/custom card is dismissed when a normal message is sent, with no widget-response or widget-dismiss request. The existing Electron fixture passes in light and dark themes for direct and group presentation, including navigation, abandoned custom input, keyboard shortcuts and dismissal retry behavior. TypeScript checks and architecture boundaries pass.

The final signed-in startup closure measures 1,336,500 bytes versus 1,334,586 in an untouched build of the same base main commit, an increase of 1,914 bytes. Its budget gains a bounded 2 KB allowance. The final desktop build passes. The size gate still reports two identical pre-existing failures in both builds: preload is 10,008 bytes against a 10,000-byte limit, and the voice-memo closure is 67,330 against 64,900. Those ceilings and modules are unchanged.

For the November 14 preview/focus follow-up, 37 targeted TypeScript tests and all 301 Swift core tests pass. Desktop and product-core TypeScript checks and architecture boundary checks pass. Coverage includes the actual Grok notification title/body, prompt-only summaries, suppression of all chats while focused, background delivery, read reconciliation and throttling.

The additional interaction pass expands this to 42 targeted TypeScript tests and 302 Swift core tests, all passing. All four Electron direct/group and light/dark cases pass with new checks for custom-field shortcut focus, IME Enter isolation, and empty Done dismissal. Both native iOS tests pass: empty Done uses the dismiss endpoint without a widget response, and a normal composer message abandons the card draft without invoking either widget action endpoint. The first empty Done run exposed missing widget action routes in the isolated fixture server; those routes now return authoritative card state and mutation receipts. The corrected simulator rerun passes. Desktop typechecking, architecture boundaries, and the final desktop build pass; the size gate retains only the two baseline failures above.
