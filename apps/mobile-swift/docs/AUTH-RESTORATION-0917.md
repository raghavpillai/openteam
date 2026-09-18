# React Native sign-in restoration — September 17, 2026

The Swift sign-in page now uses the original React Native `AuthGate` composition instead of the three-bot welcome and native Form pages. The standalone robot launch screen remains separate.

Source of truth: `apps/mobile/src/components/auth-gate.tsx`, `glass-surface.tsx`, and the shared robot artwork. Historical React Native image: `output/mobile-full-qa-0914/onboarding-offline.png`.

## Restored presentation

- Nine original silhouettes, colors, rotations, and window-relative positions, including the partly clipped edge bots.
- Whole-bot floating motion: alternating 2.5-point horizontal travel, 4–6.5-point lift, 2.2-degree rocking, and 1.8% scale. Each sine-eased leg lasts 1.75–2.29 seconds, with a 95-millisecond stagger. Robot facial artwork remains still, as in the React Native auth page.
- OpenTeam glass hero, original two-line tagline, and bottom “Log In” button. The hero moves upward and the server/account panels slide horizontally over the same bot field.
- Auth-specific backgrounds (`#F5F5F3` light, `#101010` dark), glass tints, field fills, and borders from the React Native source. Chat colors are unaffected.
- Keyboard lifting, scrollable forms at large text sizes, HTTP notices, retry/error messages, password reveal, cancellation, and existing re-authentication behavior.
- Reduce Motion stops decorative motion. Leaving the app or removing the sign-in screen releases its animations. Decorative bots are excluded from accessibility.

The restored forms become interactive after the slide finishes. UI automation explicitly waits for arrival: SwiftUI exposes destination accessibility frames before the visible panel finishes moving. The large-text viewport is measured independently of the content so it can scroll rather than overflow its glass card.

## Validation

Ten distinct authentication scenarios passed: onboarding/HTTP validation, rejected credentials and retry, rate limits/server errors/incomplete sessions, cancellation and late responses, session expiry, offline re-auth reset, dark re-auth, largest-text sign-in, persistent Keychain reset, and light/dark visual navigation. The cancellation assertion was updated to check visibility/hit testing of the retained offscreen panel; its focused rerun passed. A final visual rerun also passed after matching placeholder contrast and glass press feedback.

Frame comparisons confirm all nine bots animate in both appearances and that all nine stop with the actual simulator Reduce Motion preference enabled. Background pixel samples are exactly `#F5F5F3` and `#101010`.

Results and original simulator captures are under `output/swift-auth-restore-0917/`. Distribution evidence is under `output/testflight-native-24/`.

This is a source-based restoration with a historical React Native screenshot comparison. The platforms' native glass renderer and font rasterization are not asserted to be byte-identical screenshots. Authentication checks use the actual Swift HTTP client against the isolated HTTP fixture; no production account or third-party OAuth is used for this visual change.
