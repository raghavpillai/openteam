# Left-edge navigation and message gestures — September 17, 2026

A rightward drag starting near the left edge could select a bot message for reply instead of returning to the conversation list. The baseline native UI test reproduced this at x=22 points over a text bubble: the chat remained visible and its reply composer opened.

The message pan recognizer accepted any sufficiently horizontal rightward movement. The custom navigation chrome re-enabled only the edge pop recognizer and cleared its delegate, without coordinating it with message pans and long presses. Blocking message drags near the edge alone prevented the accidental reply but left an inactive strip just inside the native edge.

## Behavior

- On iOS 26, the first 32 points of the navigation view's leading edge belong to native back navigation. Both UIKit edge and content-pop recognizers keep the system's interactive transition; the content recognizer is restricted to this strip so interior message drags retain swipe-to-reply.
- Older iOS versions use the narrower native edge recognizer and a 16-point protected strip. This fallback compiles but has not received the same runtime validation as iOS 26.5.
- Ownership is decided from the initial touch position. A canceled back transition cannot fall through into reply selection or message feedback.
- Horizontal navigation yields to vertical scrolling. Interior message swipes, long presses, form controls and attachment taps remain available.
- Recognizer delegates and enabled states are restored when the owning page disappears. Root pages cannot begin a pop; repeated navigation through profiles and previews must not disable later navigation.

## Evidence

**Final acceptance: 11 native UI tests passed, 0 failures, on iOS 26.5 / iPhone 16 Pro Max simulator.** Haptic checks verify dispatch and suppression through the instrumented native API, not physical feedback on a phone.

The final suite uses slow drags at x=3, 22 and 32 points and fast completed drags over text, photos and files. It separately tests canceled transitions with and without the keyboard, haptic dispatch, interior message actions, attachment previews, vertical scrolling and repeated nested navigation.

A diagnostic fast drag ending at 85% of the screen intermittently canceled after UIKit began the transition. An unmodified `NavigationStack` reproduced the same cancellation (`NativeControl.xcresult`, with its temporary view/test retained in the output directory). The final fast-completion checks end at 95% with no pause before lifting; intentional cancellation remains a separate assertion. We leave completion/cancellation to UIKit. Diagnostic logging and the control screen are absent from the shipped source.

UIKit documents [content-pop recognition](https://developer.apple.com/documentation/uikit/uinavigationcontroller/interactivecontentpopgesturerecognizer) separately from its [leading-edge recognizer](https://developer.apple.com/documentation/uikit/uinavigationcontroller/interactivepopgesturerecognizer). Both participate in gesture priority here; the app does not call a synthetic pop after a drag.

The baseline is `Before.xcresult`; the final acceptance bundle is `Acceptance.xcresult`. Repeat against the isolated fixture with `SWIFT_PARITY_PORT=20043 bun apps/mobile-swift/scripts/parity-server.ts`, then run the `EdgeBack` Xcode scheme on an iPhone simulator.

Focused simulator results and screenshots are retained under `output/swift-edge-back-0917/`. The suite covers text and attachments, edge positions, fast and slow drags, keyboard-open drafts, cancellation, interior reply/long press, attachment previews, vertical edge scrolling, and repeated profile/chat/home transitions. Diagnostic and failed intermediate attempts are retained separately from final acceptance results.

This is gesture QA on an iPhone simulator running iOS 26.5, not a new whole-app or physical-device acceptance claim. Broader findings remain in [QA status](QA-STATUS-0917.md).
