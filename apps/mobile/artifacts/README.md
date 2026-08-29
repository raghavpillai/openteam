# iOS simulator validation captures

Captured on 2026-08-28 from the native OpenBot development build running on an iPhone 17 Pro simulator with iOS 26.5 and Xcode 26.6.

- `ios-home-clean.png`: home roster after replacing deprecated React Native safe-area usage.
- `ios-home.png`: initial native launch showing the deprecated-safe-area warning that triggered that fix.
- `ios-chat.png`: light conversation, reaction, reply context, approval card, and resting composer.
- `ios-composer-keyboard.png`: reproduction of explicit-newline clipping before the fallback fix.
- `ios-composer-multiline-fixed.png`: two visible lines after the composer sizing fix.
- `ios-composer-44pt-final.png`: resting composer after removing closed reply-tray padding from layout.
- `ios-composer-reference-aligned.png`: compact resting composer with the saved-reference gutter and control spacing.
- `ios-composer-reference-aligned-multiline.png`: two-line composer verification with the same reference-aligned geometry.
- `ios-composer-reference-aligned-reply.png`: expanded reply tray using the final composer geometry.
- `ios-composer-reference-final.png`: final resting state with a 44-point detached attachment control and 44-point field.
- `ios-search.png`: full-screen message-content search result.
- `ios-chat-dark.png`: dark conversation and approval/composer surfaces.
- `ios-chat-dark-final.png`: dark conversation after matching the high-contrast microphone treatment.
- `ios-search-dark-final.png`: dark search surface and recent-conversation hierarchy.
- `ios-composer-dark-multiline-reply.png`: combined dark multiline and expanded-reply verification.
- `ios-composer-dark-multiline-collapsed.png`: dark multiline composer after dismissing reply mode.
- `ios-ui-audit-before.png`: pre-audit conversation capture showing the oversized shared controls.
- `ios-ui-audit-composer-final.png`: compact composer after separating visible control size from tap-target size.
- `ios-ui-audit-final.png`: final conversation pass with the compact composer, header controls, and reaction pill.
- `ios-ui-audit-home-final.png`: final home-roster pass with the refined top controls.

These validate OpenBot behavior and rendering in the simulator. They are not Grok Bot reference captures and must not be used to claim pixel parity with the proprietary reference app.
