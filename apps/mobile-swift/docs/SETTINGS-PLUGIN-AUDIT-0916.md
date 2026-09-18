# Settings and plugins — ten-screen QA follow-up

**Later fixes:** [Swift backlog fixes and validation](BACKLOG-FIXES-0917.md) supersede the delivery, plugin access/OAuth, approvals, thread/search and computer-gesture findings described below. Historical captures remain unchanged.

**Push follow-up:** [Native push implementation and acceptance](NATIVE-PUSH.md) addresses the QA-01 implementation gap and fixes QA-08. Signed-device APNs delivery remains unverified; the other 20 findings are unchanged. The audit evidence below describes the pre-fix state.

The Swift screens do not yet match these references. The main differences are component choice, grouping, sheet size, interaction states and missing controls, not just Liquid Glass opacity. This is an audit of current behavior; application implementation was not changed during this pass.

**Three new findings bring the backlog to 22.** The existing OAuth-return finding QA-15 is now reproduced, rather than only code-confirmed. The focused `Audit-2.xcresult` run contains **8 tests: 4 passed, 4 failed, 0 skipped**, with all four failures at the expected missing behavior. The failures are preserved as ordinary failing assertions.

`Catalog-Final.xcresult` repeats the passing catalog capture/recovery case with exactly one installed plugin, matching photos 2/8/10's setup. It contains one pass and no failures or skips; it does not replace or resolve the four failures above.

The reference set is the ten photos in attachment directory `6BB99159-049A-491D-B3E4-49071B685C10`. [Open all ten side-by-side comparisons](../../../output/swift-settings-plugins-0916/review/index.html). The gallery preserves original screenshots, hashes, accessibility trees, request receipts and actual test outcomes, including failures. Where the native screen has no equivalent, the closest available state is explicitly labeled rather than fabricated.

## Behavior defects

| Finding | Severity | Expected and actual behavior | Evidence |
| --- | --- | --- | --- |
| QA-15, existing finding now reproduced | P2 | Returning from authorization should refresh the account status. The fixture changes the connection to `ready` during an inert external-browser handoff. After return, the installed-plugin detail still displays `Needs Auth`. There is no pending/cancel/reopen/expiry presentation on that screen. | `testAuthorizationReturnRefreshesConnection`; photo 7 comparison and authorization-return receipts. [Sign-in action](../Sources/App/PluginsView.swift#L110), [explicit reload only](../Sources/App/PluginsView.swift#L208). This verifies UI lifecycle, not Google OAuth itself. |
| QA-20, new | P2 | A successful bot-access retry should clear the earlier failure. The recovered bot toggle appears, but `limit is outside the supported range` remains at the top of the form. `loadAccess()` never clears `operation.failure` on success. | `testAccessErrorClearsAfterSuccessfulReload`; screenshot and receipt retain the successful reload and stale error together. [Load access](../Sources/App/PluginsView.swift#L217). The fixture bypasses the separately confirmed page-limit bug after the first failure solely to exercise recovery. |
| QA-21, new | P3 | Searching for a nonexistent plugin should explain that nothing matched. Instead the installed/discover results disappear without a no-results message; the unrelated Plugin workspace link remains. The existing empty-state check tests the entire catalog rather than the filtered results. | `testNoMatchingPluginsHasAnEmptySearchExplanation`; `search-no-results` screenshot. [Empty state and filter](../Sources/App/PluginsView.swift#L40). |
| QA-22, new | P2 | If uninstall commits but its acknowledgment is lost, retry should reconcile the removal. The app retains the installed detail, then retries DELETE; the server returns 404 and the detail remains. There is no removal reconciliation on that error path. | `testUninstallReconcilesAfterLostSuccessResponse`; lost-acknowledgment screenshot and receipts. The actual production API/database independently returned **200 / removed**, followed by **404 / plugin_not_installed** in `uninstall-production.json`. [Uninstall flow](../Sources/App/PluginsView.swift#L184), [mutation error path](../Sources/App/AppStore.swift#L549), production `apps/server/src/services/plugin/installations.ts:279`. |

QA-09 and QA-10 remain open: plugin access requests 100 rows against a server limit of 60, and enablement is incorrectly treated as connected-account access. QA-01 remains open: bot notification preferences do not implement native APNs. Those are not counted again as new findings.

## Screen-by-screen comparison

| Photo | Reference behavior | Current Swift result / gap |
| --- | --- | --- |
| 1 | Grouped Notifications, Appearance, Language, Haptics, support/legal links, feedback, sign-out and branded version footer | Appearance and haptics work, but grouping and layout differ. Notifications are in a separate per-bot screen with no native push delivery. Language/time zone are informational under More preferences. Privacy Policy, Terms of Service and the branded version footer are absent. Help opens a repository; feedback shares version text. |
| 2 | Catalog with logos, Featured/Team sections, installed-count pill, filter, top glass search and contextual Retry/Add buttons | Native uses an inset grouped Installed/Discover list, plain text rows, bottom system search and disclosure arrows. There are no logos, featured/team sections, count pill, filter, or row action/status controls. A failed connection is invisible in the catalog. |
| 3 | Removal-success banner while retaining an uninstalled detail with Add | Native returns to the catalog after acknowledged removal, without the banner or retained detail. The removal itself succeeds. |
| 4 | Centered uninstall alert with explanation and explicit Cancel/Uninstall | Native iOS 26.5 shows a small confirmation popover near the top, distant from the bottom Uninstall plugin row. It has no explicit Cancel button or removal explanation in this presentation; outside-tap dismisses it. |
| 5 | Ellipsis → translucent Uninstall menu | There is no ellipsis menu. Uninstall plugin is a full-width form row at the bottom. The comparison shows this actual alternative entry point. |
| 6 | Compact failed-connection detail, icon, description, Includes/View source and one Retry action | Native shows publisher/version, raw connection state, Connection settings, Connect, Sign in, Disconnect and Bot access in a large form. Includes/View source and a contextual Retry button are absent. The page-limit error is visible above the detail. |
| 7 | Native authentication consent prompt over an Adding state | The app uses external `openURL`; there is no corresponding in-app authentication-session prompt or Adding state. The comparison shows the app after returning from the inert handoff, explicitly labeled. It does not simulate a Google login or native consent sheet. QA-15 reproduces stale status on return. |
| 8 | Catalog shows Authorize for the installed account needing sign-in | Native does not expose authorization state in the row. Users must open the plugin to find Sign in. Catalog presentation is effectively the same as photo 2's error state. |
| 9 | Account/usage/update, plugins, auto-review and rules, automatic/manual bot time zone and Bot Computer | Self-hosted account/server details are real but differ from the subscription account reference. Usage and update UI are absent. Auto-review/rules are only a desktop-management explanation. The bot-computer and automatic/manual time-zone controls are absent. Server APIs for auto-review and computer display already exist, but Swift does not call them. |
| 10 | Persistent glass header/search/count and centered loading spinner | Native shows a Loading plugins row in a grouped list and bottom search, without the count pill. Loading failure has a working Retry button. |

The language/time-zone labels describe local device preferences. They do not implement synchronization of a bot computer's time zone, manual override, or an in-app language selector. The target ships English app text and no localization resources. Haptics were tested as a retained preference value; tactile output requires physical hardware.

The glass detail also differs visibly. At the same normalized catalog-button sample, the reference median RGB is **(51, 51, 51)** and native is **(37, 37, 39)**. The sheet sample is **(20, 20, 20)** versus **(28, 28, 30)**: the native button is darker while its sheet is lighter. These are rendered-color measurements, not inferred transparency percentages. Coordinates, originals and the enlarged crop are recorded in the gallery manifest.

## What works in these flows

- Appearance changes and haptics values survive navigation away and back; tests restore the original haptics value.
- Catalog loading is a real awaited request. An injected failure displays an error and Retry successfully reloads the catalog.
- Failed install remains retryable and a successful retry produces an installed entry.
- Repeated Connect taps while the request is held produce only one HTTP request. The connection status updates after it completes. The lack of visible progress is a presentation gap, not duplicate connections.
- Dismissing uninstall confirmation sends no DELETE. A failure before removal preserves the installed detail and can be retried successfully.

## Reproduction and coverage limits

Start independent fixtures:

```sh
SWIFT_PARITY_PORT=20013 bun apps/mobile-swift/scripts/parity-server.ts
bun apps/mobile-swift/scripts/settings-plugin-audit.ts
```

Run the optional `SettingsPluginAudit` Xcode scheme on iOS 26.5. Its failing assertions document current defects; it is excluded from the default native suite. The proxy uses `needs_auth`, the production 60-row limit and the production uninstall 404 contract. Failure injection and account state are synthetic. No connected account or real provider is contacted.

The production uninstall receipt uses `scripts/audit-plugin-uninstall.ts` with the disposable API/PostgreSQL harness in [SYSTEM-QA.md](SYSTEM-QA.md). It creates and removes only its own synthetic installation, with no connectors or credentials. Do not point the probe at a personal database.

Original exploratory bundles remain available. Early test corrections account for virtualized form rows, the combined `Status, Ready` accessibility label, and iOS's outside-tap confirmation dismissal. Those harness issues are not reported as app failures.

This pass does not establish real provider OAuth, physical notifications/haptics, legal/support destinations, subscription billing, signed-device settings behavior, or whole-app pixel identity. [The earlier audit](QA-AUDIT-0916.md) remains the rest of the open backlog.
