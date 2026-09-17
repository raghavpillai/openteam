# Grokbot visual reference and native design decisions

The Swift app's surrounding UI target is the supplied Grokbot captures. The user clarified that the character must be OUR OpenTeam desktop robot, including its artwork and motion. Reference audit: September 16, 2026.

## Reference sources

- All 21 entries in `output/mobile-every-screenshot-0915/manifest.json` were inspected. The original attachments still exist and are used by the export script, with hashes and explicit crops. Cases 3 and 12 are earlier OpenTeam screenshots, not Grokbot targets. Cases 4, 5, 18, 19 and 20 repeat earlier references. Case 21 is a composite: only its Grokbot header crop is a target.
- The five follow-up `Photo 1.jpg` through `Photo 5.jpg` references cover Home, Search, conversation hold, message hold and scrolled Home. Their separate review is `output/swift-floating-reply-0916/review/index.html`; source paths, original hashes and exact XCTest sources are in its manifest. Export it with `scripts/export-floating-review.py`.
- Five screenshots from the [official App Store listing](https://apps.apple.com/us/app/grok-bot/id6794501026) were downloaded and inspected. Source URLs are recorded in `output/swift-grokbot-visual-0916/references-online/sources.json`.
- The [xAI announcement](https://x.ai/news/introducing-grok-bot) and [official mobile documentation](https://docs.x.ai/grok-bot/mobile) establish product context. Marketing screenshots support the supplied device captures; they do not replace them.

## What carries over

Keep the HTTP contract, secure authentication, delivery nonces, persisted drafts/outbox, upload state, server events, permissions and real feature behavior. Match the reference's geometry, typography, palette, shape language, grouping and visible states directly in SwiftUI.

The compact header uses 44-point controls, a 27-point bot mark and a title capsule. Chat uses 17-point system type, 24-point bubble corners, a 16-point history gutter and an integrated microphone/send control. The resting composer has a 30-point gutter; the keyboard state has an 18-point gutter. Dark background is `#141414`, user fill `#5C5C5C`, assistant fill `#202020`. Measured glass interiors are approximately `#333333` in the static dark reference.

Home uses flat 80-point conversation rows and section labels. Bot creation keeps the centered name field and bottom capsule action, with our twelve desktop robot identities and eleven desktop colors. Settings/search/actions use native sheets with compact content instead of large navigation titles.

Home, Search and Chat have no painted full-width header background; Chat's composer has no painted full-width gradient. Only the individual controls receive glass and its native shadow. Scrolling content continues beneath the controls. On iOS 26, `floatingBar` registers these controls using Apple's [safeAreaBar](https://developer.apple.com/documentation/swiftui/view/safeareabar(edge:alignment:spacing:content:)) and [soft scroll-edge effect](https://developer.apple.com/documentation/swiftui/scrolledgeeffectstyle/soft), matching the faded content behind Photo 5's header. Earlier iOS versions use clear safe-area insets and material controls with a local shadow.

The transparency follow-up keeps native Liquid Glass, as explicitly confirmed by the user. Light controls use regular glass with a faint neutral tint (`black` at 0.025), replacing the prior white tint at 0.24. This reduces the whitewashed surface while retaining native contrast adaptation over message text. Dark glass remains unchanged. The comparison is `output/swift-glass-0916/review/index.html`, with original reference/before/after screenshots and explicit detail crops recorded in its manifest. Static appearance samples are not measurements of material transmittance. Apple's [material guidance](https://developer.apple.com/design/human-interface-guidelines/materials) recommends regular glass where underlying content can affect legibility; system appearance and accessibility settings remain authoritative.

Holding a plain message opens the reaction/action sheet; Reply selects its inline quote and focuses the composer. A rightward swipe also selects Reply. Inline send preserves `replyToMessageId` with `isFork=false`; Start a thread uses forked context. Queued/failed replies show the same quote as delivered messages, and quote taps return to the original. Rich interactive cards retain their child gestures and expose Reply/Message actions through accessibility actions.

## What iOS owns

Do not port JavaScript keyboard-height interpolation, sheet springs, context-menu lift/blur, glass shaders, navigation transition drivers, emoji rendering, focus animation or haptic scheduling. Use system safe areas, SwiftUI sheets and menus, UIKit interactive navigation, native glass on iOS 26, material fallback on iOS 18–25, system keyboards and feedback generators. The reply gesture uses SwiftUI animation. The bot character uses the custom native vector timeline described in `BOT-MOTION.md`; both respect Reduce Motion. Haptics respect the app setting.

The native client contains no animation runtime copied from the React Native app. Our robot is a native Core Animation layer hierarchy generated from `packages/design-tokens/src/robot-avatar-artwork.ts`, with matching CSS keyframes and the desktop transition controller translated to Swift. Grokbot character geometry and animation are excluded from the app. See [bot motion provenance, implementation and remaining exact-parity work](BOT-MOTION.md).

## Comparison and interpretation

Use the `GrokbotVisual` scheme against the loopback-only visual fixture on port 19996. It runs real UI interactions, including create, long press, reply and keyboard input. The in-memory fixture reproduces the inert reference text and bot names; it does not run workers or contact external services. DEBUG-only launch flags select the fixture scene, appearance, channel and draft. None bypass authentication in a release build.

Export with `scripts/export-grokbot-comparison.py`. Every capture must come from the selected result bundle, not a stale screenshot folder. Images are resized to a common 440-point width; only explicitly recorded source crops are applied. No retouching, color correction, status-bar replacement or pixel alignment is performed. The prior RN capture is available as historical context, separately labeled.

Differences that must remain explicit:

- System status indicators, keyboard predictions, emoji rendering, glass and menu internals vary with iOS version, device and settings. The system controls remain native.
- Connected account identity, server address and supported settings are real OpenTeam data. Do not invent Grok subscription, quota, payment or email services to fill a screenshot.
- Mid-gesture and completed-reply screenshots are different states. A completed swipe proves behavior, not visual equivalence to an in-progress drag. A recorded simulator video can supply an actual intermediate frame; its timestamp and source must be recorded.
- Robot artwork and motion intentionally match OpenTeam desktop rather than the Grokbot screenshots. Scroll position, text wrapping, header overlap and spacing remain app-owned differences to inspect and correct. Do not explain these away as operating-system variation.
- The supplied set does not cover every profile, plugin, rich-card, routine, computer or authentication state. A reference match for chat/home/create is not a full-product parity claim. The remaining functional cutover gates are in `PARITY.md`.
