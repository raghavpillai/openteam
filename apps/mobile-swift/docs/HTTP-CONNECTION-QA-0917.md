# Live HTTP connection regression — September 17, 2026

The native iOS app could not connect to `http://100.94.42.50:8787` through build 16, despite the server being healthy and the shared API passing host-based probes. This was reproduced in the actual app: Continue showed a generic connection failure, and iOS logged `NSURLErrorDomain -1022` with an App Transport Security cleartext rejection.

The native Info.plist contained both `NSAllowsArbitraryLoads` and `NSAllowsLocalNetworking`. The latter causes modern iOS to ignore the broad allowance. The React Native configuration contained only `NSAllowsArbitraryLoads` and already had a regression assertion against adding the conflicting key. Removing the extra native key restores the intended support for user-selected HTTP servers. [Apple documents this override](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowsarbitraryloads).

## Actual app verification

The dedicated `LiveHTTP` Xcode scheme runs against the main installation through its real Tailscale addresses, without a fixture proxy. It is excluded from ordinary offline UI suites. Both cases passed on the owned iPhone 16 Pro Max simulator with iOS 26.5:

- HTTP: `http://100.94.42.50:8787`.
- HTTPS: `https://office-mac-mini.tail658346.ts.net:10000`.

Each case checks healthy server/auth-config responses without changing URL schemes, opens the native server screen, presses Continue, verifies the username/password screen appears, and submits deliberately invalid synthetic credentials to verify a real authentication response. No owner credentials, account data or messages are modified. Successful sign-in with the owner's account and the physical phone's Tailscale connection are outside this check.

**50 core tests and 2 live native UI tests pass.** The new configuration regression prevents fine-grained ATS keys from silently overriding HTTP support. Release verification additionally asserts the exact transport configuration inside the signed IPA; debug fixtures alone are insufficient evidence for this behavior.

Evidence: `output/swift-live-http-0917/` contains the original failed run, the iOS network failure, the passing `Fixed.xcresult`, screenshots and `review.html`. TestFlight packaging and delivery receipts are in `output/testflight-native-17/`.

Reproduce with the local Tailscale server running:

```sh
xcodebuild -project apps/mobile-swift/OpenTeamNative.xcodeproj \
  -scheme LiveHTTP -destination 'platform=iOS Simulator,id=<owned-simulator-UDID>' \
  -parallel-testing-enabled NO test
```
