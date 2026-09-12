# Onboarding and login QA

This workflow exercises the production desktop and iOS `AuthGate` components with a loopback-only server and synthetic accounts. It does not require a real OpenTeam account. Use a disposable iOS simulator because the native gate uses its real Keychain and server preferences.

## Automated regression checks

Run from the repository root. The explicit `./` paths prevent Bun from matching copied source trees under `output/`.

```sh
bun test ./packages/client-core/test/auth.test.ts ./packages/client-core/test/auth-resilience.test.ts ./packages/product-core/test/auth-feedback.test.ts ./apps/desktop/test/auth/*.test.ts ./apps/mobile/test/auth.test.ts ./apps/mobile/test/list-ui-parity.test.ts
```

The functional checks cover response validation, sign-in/out, native credential persistence, unavailable storage and retry, rejected session verification, stalled fetches and response bodies, cancellation, late responses, timer cleanup, HTTP error fallbacks, and redaction. The UI parity checks protect existing structural conventions; they do not replace interactive QA.

## Local fixture

```sh
bun apps/desktop/test/fixtures/auth-qa-server.ts
```

Use `qa` / `test-login` for a successful synthetic login. Any other password fails. The fixture only listens on `127.0.0.1:18787`.

| Server address | Scenario |
| --- | --- |
| `http://127.0.0.1:18787` | Normal login and session |
| `http://127.0.0.1:18787/wrong-server` | Reachable HTML page instead of OpenTeam |
| `http://127.0.0.1:18787/unavailable` | Server maintenance, HTTP 503 |
| `http://127.0.0.1:18787/slow` | Response delayed past the 15-second deadline |
| `http://127.0.0.1:18787/limited` | Sign-in rate limit, HTTP 429 |
| `http://127.0.0.1:18787/bad-response` | Login succeeds without a session token |
| `http://127.0.0.1:18787/no-auth` | Server configured without authentication |

Also test an invalid address such as `not a server`, an empty field, and an unused loopback port. HTTPS is recommended for real servers; the native HTTP warning is expected for this loopback fixture.

## Desktop harness

In a second terminal:

```sh
cd apps/desktop
VITE_OPENTEAM_API_URL=http://127.0.0.1:18787 bunx vite --port 5196
```

In another terminal, from the repository root:

```sh
apps/desktop/node_modules/.bin/electron apps/desktop/test/fixtures/auth-qa-window.cjs
```

The wrapper creates a temporary Electron profile. Its toolbar switches light/dark appearance. Start the wrapper with `OPENTEAM_AUTH_QA_STORAGE_ERROR=1` to simulate one failed Keychain read and verify startup recovery; this mode substitutes an in-memory authentication bridge. It renders the actual auth gate and a minimal signed-in screen. Its transport uses the browser adapter; the separate native-client and session tests cover the Electron authentication bridge.

Check Return, Tab/Shift-Tab, Escape/Back, disabled empty forms, error clearing on edits, preserved username after a failed password, password clearing when changing servers, pending-button feedback, successful login and sign-out. Resize the window and verify the form scrolls so both actions remain reachable.

## iOS harness

Install a signed development simulator build of `dev.openbot.mobile` on a fresh simulator. Simulator builds must retain the Keychain entitlement. Start Metro and the QA entry proxy in separate terminals:

```sh
EXPO_PUBLIC_OPENTEAM_API_URL= bun --cwd apps/mobile dev --localhost --port 8083
```

```sh
bun apps/mobile/test/onboarding-qa-metro.ts
```

Open the native development menu, choose **Configure Bundler**, and enter host `127.0.0.1`, port `8084`, and entry `apps/mobile/test/onboarding-qa-entry`. The proxy keeps Expo reloads on the test entry without changing the production entrypoint. Use the development menu's **Reload** after code changes; this small proxy does not forward the Fast Refresh websocket.

The harness provides light/dark appearance and, after login, **Sign out and reset**. It uses the production auth components, actual native glass, secure storage, keyboard, and accessibility APIs. Dismiss the password-save prompt for the synthetic account.

Check the software keyboard explicitly using Simulator's **I/O → Keyboard → Toggle Software Keyboard**. Confirm the username Return key moves to password, validation text fits above the keyboard, content can scroll when space is limited, and the action buttons remain reachable. Check notice expansion/collapse, repeated taps while pending, invalid-password retry, and entry into the signed-in screen.

On the disposable device, enable **Settings → Accessibility → Motion → Reduce Motion** and repeat a stage change and error. Decorative movement and sliding transitions should stop. Repeat with larger text before a release, and use a physical device for VoiceOver speech and haptic assessment.

## Results — 2026-09-12

- 93 focused tests passed, 532 assertions, with no failures.
- Desktop, mobile, client-core, and product-core typechecks passed.
- Desktop production renderer build and iOS production export passed.
- Interactive Electron QA passed: malformed/empty URL, incompatible server, HTTP 503, 15-second timeout and retry, wrong password and retry, successful login, sign-out, keyboard focus/Return/Escape, dark/light appearance, HTTP 429 message, startup storage-error layout and successful recovery, and scrolling at approximately 440 × 520.
- Interactive iOS QA passed on iPhone 17 Pro / iOS 26.5: fresh welcome flow, malformed/empty URL, inline error above the software keyboard, clearing errors while editing, username Return to password, incorrect credentials and retry, successful login, password-save prompt dismissal, sign-out/reset, dark/light appearance, a stalled request exiting the busy state, and recovery into an auth-disabled test server.
- Native Reduce Motion passed with the OS preference enabled, including a stage change and inline validation error.

This was an expert QA pass using synthetic fixtures, not a usability study with recruited users. Physical-device haptics, spoken VoiceOver output, large Dynamic Type sizes, live production authentication, and network switching were not evaluated in this pass. These remain release-device checks.
