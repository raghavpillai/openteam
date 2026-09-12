# iOS haptic design and OpenTeam interaction audit

OpenTeam uses three system haptic families and six patterns: selection, light impact, medium impact, success, warning, and error. Swipe-to-reply already had feedback before this review. It now uses the same light impact for both a deliberate drag and a quick flick, and it cannot emit a second application-generated cue during the same gesture.

The appropriate design goal is meaningful, consistent feedback. A productivity app does not benefit from vibrating on every tap. This review retains feedback for changing selections, gesture boundaries, important completed actions, and actionable failures. Ordinary navigation is quiet, and a saved **App haptics** switch provides control over the application's custom feedback.

The implementation review covers the mobile routes, shared controls, haptic adapter, reply gesture, persistence, and installed Expo bridge. Source material was checked on September 12, 2026. Physical strength, perceptual timing, and comfort on current iPhones remain unverified. The findings below distinguish platform documentation, empirical evidence, and OpenTeam-specific design decisions.

## Evidence and its implications

### Apple’s design guidance

Apple recommends preserving the documented meaning of system patterns, keeping feedback consistent, avoiding excessive repetition, making haptics optional, and retaining a usable experience without them. Native controls such as supported switches, sliders, and pickers already provide feedback; adding another cue can duplicate their response.[^1]

Apple’s 2019 design session describes three useful principles: an understandable cause, agreement between senses, and practical value. Its examples deliberately omit feedback from minor interactions. For OpenTeam, this supports placing a cue at the moment a reply gesture becomes ready, while leaving ordinary Back, Close, and navigation buttons quiet. This is an application of the principles, not an Apple prescription for a particular messaging interface.[^2]

The 2021 session demonstrates the relationship between an animation and its apparent physical properties. A stronger cue should have a corresponding visual or functional reason. Adding more patterns does not establish a better experience; the useful test is whether the event becomes clearer. OpenTeam therefore retains a small vocabulary rather than adding custom vibration sequences.[^3]

### Standard patterns have distinct meanings

Apple describes selection feedback as movement through changing discrete values. The specific `selectionChanged()` documentation excludes using it merely to make or confirm a selection. This makes it a poor default for every button, a link opening, or a completed save.[^4]

Impact feedback represents a physical event in the interface, such as an object reaching a boundary. Light, medium, and heavy describe perceived mass; soft and rigid describe material character. They are not urgency levels. OpenTeam's light reply cue represents reaching the gesture's detent, not successful network delivery.[^5]

Notification feedback represents outcomes: successful completion, a warning, or failure. It should correspond to what actually happened. Successfully declining an approval is still a successful user action. Opening an authorization browser, by contrast, does not establish that authentication succeeded.[^6]

| Pattern used | OpenTeam meaning | Representative interactions | Avoid |
| --- | --- | --- | --- |
| Selection | A discrete value changed | Appearance, avatar choices, group membership, search category, reaction toggles | Back, Close, links, unchanged choices |
| Light impact | A small, direct interface action or detent | Reply threshold, sending, attachment-menu reveal, acknowledged Run Now request | A claim that a remote task finished |
| Medium impact | A deliberate contextual-menu reveal | Long-press message or conversation actions | Routine form submissions |
| Success notification | A meaningful action completed | Login, explicit save, creation, approval resolution, accepted handoff completion | Browser launch, optimistic toggle, queued task completion |
| Warning notification | An action produced a caution | A file selection exceeded remaining attachment capacity while acceptable files were retained | Merely declining an approval |
| Error notification | A user-requested action failed or cannot proceed | Connection, send, save, approval, attachment, plugin, or handoff failure | Typing validation on every keystroke or recurring background failures |

The last two columns are OpenTeam design decisions informed by these meanings. Heavy, soft, rigid, continuous effects, and custom Core Haptics patterns are not used by the reviewed application call sites. Their availability is not a reason to add them.

### Timing evidence and its limits

A 2014 controlled study by Kaaresoja, Brewster, and Lantz tested 24 participants with a purpose-built virtual-button device. It proposed a tactile feedback latency range of 5–50 ms and found worsening perceived quality at longer delays. This supports paying attention to tactile timing, but it does not establish a universal 50 ms requirement for a 2026 iPhone reply gesture. The study concerns button presses, uses older hardware and a limited participant sample, and explicitly notes that preferences can change as technology develops.[^7]

For OpenTeam, the practical inference is to request gesture feedback at the boundary event, avoid arbitrary delays, and measure the native experience under load. The 5 ms lower figure is not a reason to add an artificial delay. A network-success cue should occur with the confirmed result, which may arrive much later than the original tap; it represents a different event.

Apple's `prepare()` documentation recommends preparing a feedback generator before the triggering event. It explicitly says that preparing and immediately triggering do not improve latency. Preparation is temporary and should not be maintained indefinitely without use.[^8]

The installed `expo-haptics` 57.0.2 iOS implementation creates a UIKit generator, calls `prepare()`, and immediately triggers it on the main queue. Its JavaScript API does not expose a separate prewarming operation. Consequently, the presence of `prepare()` in the dependency is not evidence that OpenTeam has achieved low latency. This is a local dependency observation, not a measured performance failure.[^9]

The recommendation is to retain the standard Expo integration until hardware measurements show a material problem. If reply feedback feels delayed under realistic chat load, evaluate a retained native generator prepared at gesture start, together with the gesture's JavaScript scheduling. Any native change should be compared on-device before adoption. A custom waveform would not by itself resolve scheduling latency.

## Reply gesture analysis

The gesture opens the message’s thread through the existing `onStartThread` callback. The message menu separately offers **Reply** and **Start a thread**. This audit preserves that routing; “reply swipe” refers to the existing shortcut into thread replies.

Before this pass, the gesture emitted a selection tick after a 52-point drag, but a fast flick emitted a light impact on release. Retreating below 40 points reset the feedback flag, so crossing the boundary again could emit another tick. Release also used the raw 52-point test even if the earlier feedback state remained armed, creating a mismatch around the boundary.

The new `ReplySwipe` state machine separates readiness from whether a cue has already been requested. Its thresholds preserve the existing drag and flick distances while making commitment consistent with the armed state:

| Gesture case | Behavior | Application-generated haptic requests |
| --- | --- | --- |
| Drag reaches 52 points | Arms the reply | One light impact at the first crossing |
| Continue dragging or release after arming | Opens the thread | No additional cue |
| Move slightly back to 40–51 points after arming | Remains armed; release opens the thread | No additional cue |
| Retreat below 40 points | Disarms; a slow release cancels | No error or cancellation cue |
| Retreat, then cross 52 points again in the same gesture | Rearms | No duplicate cue |
| Quick flick reaches at least 24 points with rightward velocity of at least 0.65 | Opens on release | One light impact if none was requested earlier |
| Short, slow, or leftward gesture | Does not open a thread | None |
| System terminates the gesture | Resets the gesture | None on termination; the next gesture can cue normally |

These numerical thresholds are project interaction constants, not Apple standards. One cue per gesture is a deliberate restraint. After a full retreat and rearm, the visual affordance still communicates readiness even though a second tactile cue is suppressed. This tradeoff should be included in hardware user testing.

The reply arrow remains visible feedback when haptics are disabled. Under Reduce Motion, the bubble continues to track the finger, while the arrow's scaling and the automatic spring or completion travel are removed. Changes to the system setting are observed while the view is mounted. Haptic opt-out remains separate from motion preference.

Apple’s accessibility guidance supports reducing automatic motion while retaining direct gesture tracking. Its gesture guidance also requires an alternative to important custom gestures. OpenTeam retains the message action menu and its accessibility action, so starting a thread is not available only through a swipe.[^10][^11]

## Application control and graceful fallback

Settings now contains **App haptics**, using a native switch. Its explanatory text distinguishes custom app feedback from system-control behavior. Turning it off suppresses all subsequent application haptic requests through the shared adapter. It does not attempt to disable iOS’s own keyboard, picker, switch, or notification behavior.

The preference is saved independently of the server connection. The app starts quiet until the saved value is read. A first launch with no saved preference enables custom feedback; a saved opt-out keeps it disabled. Invalid or unreadable storage remains quiet. A late initial read cannot overwrite a more recent user choice.

A change takes effect immediately. The switch is disabled during persistence to prevent overlapping writes. If storage fails, the choice remains effective for the current session and an alert explains that it was not saved for the next launch. **Try again** retries the same value. Saving this preference does not generate an extra custom success or error pulse, particularly after someone has just asked to turn haptics off.

The shared adapter also requires a known active app state. Inactive, background, and unknown states suppress feedback. Synchronous native errors and rejected promises are absorbed so a supplemental haptic cannot break sending, saving, or navigation.

Expo documents additional iOS conditions in which the Taptic Engine may produce no feedback, including Low Power Mode, disabled system settings, camera use, and dictation. A resolved haptic promise cannot establish that the person felt anything. The app leaves these restrictions intact and keeps visible outcomes usable independently.[^12]

Voice input, camera capture, system pickers, incoming notifications, and continuous remote-computer input do not acquire parallel custom feedback streams. This avoids adding pulses from global listeners or on high-frequency events. These boundaries should also be checked whenever those systems change.

## Coverage across the application

The inventory covers application call sites and shared control defaults. The following assessment is based on code behavior, not a claim that every listed interaction has been felt on hardware.

| Surface | Final feedback policy and finding |
| --- | --- |
| Welcome and login | Light action feedback, then confirmed success or actionable error. Back is quiet. Saved connection success waits for persistence, and stale auth requests remain silent. |
| Composer | One light send cue; the Send icon opts out of its own cue. Mention changes use selection feedback. Explicit attachment failures and send failures get error feedback; attachment overflow can produce warning feedback. |
| Reply gesture | Same light pattern for slow drags and fast flicks; tested readiness, retreat, termination, and deduplication. |
| Message reactions | Selection feedback accompanies toggling a reaction. Failures retain visible error handling and error feedback. |
| Message menus and clipboard | Medium impact on deliberate menu reveal. Copy acknowledges completion with a light impact; copy failure produces an error. Routine links and ordinary navigation stay quiet. |
| Conversation list | Medium impact for a long-press menu; light impact for explicit swipe actions. Failed actions get errors. Generic menu rows no longer emit a selection tick. |
| Search | Category changes use selection feedback; selecting the active category stays quiet. Opening a result and revealing the filter menu stay quiet. This also removes the previous double tick from the filter icon and its handler. |
| Bot and group creation | Mode and bounded membership changes use selection feedback. Unchanged or disabled choices cannot produce a false change cue. Creation outcomes use success or error. |
| Bot profile and appearance | Avatar, accent, and appearance changes use selection feedback. Persistence failures accompany visible errors. Repeated selection of the current value is quiet. |
| Group details, instructions, and text editing | Actual member changes get selection feedback. Explicit saves get outcome feedback. Native switches do not get another selection or success cue. |
| Approvals | Both successful approval and successful decline get success feedback. A failed resolution gets error feedback. |
| Routines | Save and delete acknowledge their outcomes. Run Now gets a light acknowledgement when its request is accepted, not a success claim that execution finished. Polling stays quiet. |
| Plugins | Category changes get selection feedback. Confirmed mutations and failures retain appropriate outcomes. OAuth browser opening suppresses premature success in the manager and marketplace. The separate plugin workspace remains under development; its reviewed feedback changes belong to that feature's integration. |
| Rich questions and secrets | Discrete answer choices and submission have feedback. Rejected submissions or dismissals report failure. Successful secret storage gets success feedback. |
| Computer handoffs | Starting or finishing checks the accepted result before changing state or leaving the screen. Rejected handoffs remain retryable. Continuous remote input and its generic controls stay quiet. |
| Images and shared views | Image sharing retains light acknowledgement and failure feedback. Closing image and exchange views stays quiet. |
| Shared icon buttons | Quiet by default. A meaningful action must opt into a cue, preventing navigation and nested handlers from producing accidental feedback. |
| Settings and lifecycle | Saved app opt-out, immediate suppression, safe persistence failure, and foreground-only delivery are covered by focused tests. |

The term “error feedback” does not imply vibrating for every error anywhere in the process. Passive load failures, background retries, individual upload-progress events, and recurring connectivity updates should remain primarily visual. A blanket error listener would lose the causal connection to the user's action and could create repeated alerts.

## Changes made during this research review

The earlier audit filled missing success and failure feedback. This deeper review additionally corrected selection-pattern overuse, mismatched reply patterns, re-crossing duplicates, readiness inconsistency, missing per-app control, and the remaining legacy OAuth success paths. Login's initial impact was reduced from medium to light, reserving medium for deliberate context-menu reveals.

The implementation centers on the [native adapter](/Users/raghav/OpenBot/apps/mobile/src/haptics.ts), [feedback eligibility logic](/Users/raghav/OpenBot/apps/mobile/src/haptics-core.ts), [preference store](/Users/raghav/OpenBot/apps/mobile/src/haptic-preference-store.ts), [preference binding](/Users/raghav/OpenBot/apps/mobile/src/haptic-preferences.ts), [reply state machine](/Users/raghav/OpenBot/apps/mobile/src/reply-swipe.ts), [message bubble](/Users/raghav/OpenBot/apps/mobile/src/components/message-bubble.tsx), [settings view](/Users/raghav/OpenBot/apps/mobile/src/components/settings-home.tsx), and [settings route](/Users/raghav/OpenBot/apps/mobile/app/settings.tsx). Shared-button and navigation callers follow the same policy.

The new tests exercise the actual pure logic used by the adapter, persisted preference, and gesture. They cover opt-out across app states, unknown lifecycle state, native failures, cold-start hydration, failed and retried writes, overlapping changes, threshold boundaries, flicks, cancellation, repeated crossings, and gesture reset. Existing source-level UI regression checks remain useful for wiring, but they are not substitutes for tactile measurements.

## Verification results

| Check | Result |
| --- | --- |
| Focused haptics, preference, and reply gesture tests | 23 passed; 56 assertions across three files |
| Mobile TypeScript | Passed |
| Native configuration validation | Passed: 23 unique Expo packages and 24 unique pods |
| Production iOS export | Passed |
| Complete mobile test suite in the committed snapshot | 172 passed |
| Combined mobile, client-core, auth-feedback, and desktop auth suite | 263 passed; 1,239 assertions across 51 files |
| Physical haptic timing and comfort | Not tested on hardware |

The committed snapshot excludes the separate voice-input and plugin-workspace development changes. Its complete mobile suite passes. No speech or recording implementation was changed by this haptics review. Mobile, desktop, client-core, and product-core TypeScript checks pass; the desktop renderer build also passes.

Verification logs are in the [local research output directory](/Users/raghav/OpenBot/output/haptics-research-0912). The passing iOS export verifies bundling, not tactile performance or runtime correctness for every screen.

## Hardware acceptance protocol

A release candidate should be checked on at least two supported physical iPhones with different sizes or generations, including the oldest model the product actively supports. That sampling is a proposed project QA policy, not an Apple-mandated matrix. Apple explicitly notes that Simulator cannot provide the haptic interface required for tactile testing.[^13]

| Check | Procedure | Acceptance criterion |
| --- | --- | --- |
| Pattern meaning | Perform a selection change, menu reveal, successful save, warning, and failed action | Each feels proportionate to its visible cause; error is not used for successful decline |
| Reply readiness | Slow swipe across the threshold, hold, move slightly back, release | One cue at readiness; commitment matches the visible affordance |
| Reply cancellation | Cross the threshold, retreat below the reset boundary, release | No reply opens; no error buzz for cancellation |
| Flick and repeated crossings | Short fast flick; then repeatedly cross and retreat during one continuous gesture | Same light pattern; no more than one custom cue per gesture |
| App opt-out | Disable App haptics, exercise actions, terminate and relaunch | No custom app cues; opt-out persists; visible feedback remains sufficient |
| System suppression | Repeat with relevant system settings and Low Power Mode | No dependency on feeling a pulse; no attempted override of system behavior |
| Background completion | Start a delayed save and leave the app before completion | No background pulse; result remains correctly represented on return |
| Native-control duplication | Toggle notification and app-haptic switches; use system pickers | No second application-generated cue layered onto the control |
| Motion and alternatives | Enable Reduce Motion, use the reply gesture and the accessible action menu | Reduced automatic motion; both interaction methods remain usable |
| Realistic load | Swipe while a long conversation is rendering and incoming text is streaming | No obvious lag between readiness and felt feedback; repeated tests remain consistent |
| Comfort | Use the main flows repeatedly for several minutes | Feedback remains useful rather than tiring; compare with app haptics disabled |

For objective timing, instrument the gesture boundary and native request, then use an accelerometer or suitable external measurement setup to determine physical onset. A JavaScript timestamp measures only part of the path. Record the device, OS, app build, thermal/load conditions, and both typical and worst observed delays. Treat the historic 50 ms figure as context for investigation, not a measured result for this app.

## Remaining limits

The code now expresses a consistent policy, and the focused tests establish the relevant state transitions. They cannot demonstrate comfort, distinguishability, physical output, or timing on an iPhone. No claim of “perfect haptics everywhere” is justified until the hardware protocol is completed.

The current Expo bridge may warrant performance work if measurements reveal noticeable latency. No unsupported promise about prewarming has been made, and no native haptic engine or custom waveform was introduced without evidence that it improves the experience. Future UI additions should use the same semantic rules and explicit opt-in rather than restoring a universal button cue.

## Sources

[^1]: Apple. [Playing haptics, Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/playing-haptics). Living documentation; visible change log includes May 7, 2024. Retrieved September 12, 2026. Used for consistency, optional feedback, moderation, and native controls.
[^2]: Moussette, Camille, and Hugo Verweij, Apple. [Designing Audio-Haptic Experiences](https://developer.apple.com/videos/play/wwdc2019/810/). WWDC 2019, session 810. Used for causality, harmony, utility, and restraint.
[^3]: Moussette, Camille, Apple. [Practice audio haptic design](https://developer.apple.com/videos/play/wwdc2021/10278/). WWDC 2021, session 10278. Used for matching visual and tactile events and iterative design.
[^4]: Apple. [UISelectionFeedbackGenerator.selectionChanged()](https://developer.apple.com/documentation/uikit/uiselectionfeedbackgenerator/selectionchanged()). Undated UIKit documentation, retrieved September 12, 2026. Used for selection-change semantics.
[^5]: Apple. [UIImpactFeedbackGenerator](https://developer.apple.com/documentation/uikit/uiimpactfeedbackgenerator). Undated UIKit documentation, retrieved September 12, 2026. Used for impact semantics; corroborated by the pattern descriptions in source 1.
[^6]: Apple. [UINotificationFeedbackGenerator.FeedbackType.warning](https://developer.apple.com/documentation/uikit/uinotificationfeedbackgenerator/feedbacktype/warning), including the related success and error definitions. Undated UIKit documentation, retrieved September 12, 2026.
[^7]: Kaaresoja, Topi, Stephen Brewster, and Vuokko Lantz. [Towards the Temporally Perfect Virtual Button: Touch-Feedback Simultaneity and Perceived Quality in Mobile Touchscreen Press Interactions](https://www.dcs.gla.ac.uk/~stephen/papers/TAP%20-%20kaaresoja.pdf). ACM Transactions on Applied Perception 11(2), article 9, May 2014. DOI: 10.1145/2611387. Author-hosted paper; participant details in section 3.2 and timing guidance in section 5.1. Used with explicit age and generalizability limits.
[^8]: Apple. [UIFeedbackGenerator.prepare()](https://developer.apple.com/documentation/uikit/uifeedbackgenerator/prepare()). Undated UIKit documentation, retrieved September 12, 2026. Used for preparation timing and lifecycle.
[^9]: Expo. `expo-haptics` version 57.0.2, [installed HapticsModule.swift](/Users/raghav/OpenBot/apps/mobile/node_modules/expo-haptics/ios/HapticsModule.swift). Local dependency source; no public version-specific URL was relied on. Used to establish the actual generator creation and immediate prepare/trigger sequence.
[^10]: Apple. [Accessibility, Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/accessibility). Living documentation, retrieved September 12, 2026. Used for motion reduction, direct gesture tracking, and alternative controls.
[^11]: Apple. [Gestures, Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/gestures). Living documentation; visible change log includes September 9, 2024. Retrieved September 12, 2026. Used for discoverability, responsiveness, and alternatives to custom gestures.
[^12]: Expo. [Haptics](https://docs.expo.dev/versions/latest/sdk/haptics/). Living SDK documentation, retrieved September 12, 2026. Used for the API and documented system suppression conditions. The installed package version was verified separately.
[^13]: Apple. [Updating Continuous and Transient Haptic Parameters in Real Time](https://developer.apple.com/documentation/corehaptics/updating-continuous-and-transient-haptic-parameters-in-real-time). Sample documentation, retrieved September 12, 2026. Used only for the Simulator limitation; its historical device list is not treated as OpenTeam's current support matrix.
