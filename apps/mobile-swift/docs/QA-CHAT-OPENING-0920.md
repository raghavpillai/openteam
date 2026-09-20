# Chat opening and initial scroll position

The previous view rendered bootstrap/cached messages immediately, fetched history, then called `scrollTo` before the populated view had completed layout. Users could see the intermediate history and the subsequent correction to the bottom.

Initial opening now displays the native `ProgressView` while fetching the first history page. The populated scroll view mounts with its bottom anchor and stays hidden until scroll geometry confirms a real viewport at the bottom. Positioning does not animate. The composer becomes enabled when positioning completes. Already loaded histories can mount immediately while a refresh runs, and returning from details does not restart the loading state. Explicit message/search destinations retain their targeted scroll behavior.

Validation on iPhone 16 Pro Max / iOS 26.5 simulator:

- Three UI tests passed: slow initial history plus cached reopen in both appearances, empty-chat readiness and first send, and the existing keyboard/send/activity/scroll-to-latest regression scenario.
- The slow-history scenario injects a seven-second response delay. During loading, the spinner is present, message rows are not hittable, and the Latest messages button is absent. The first revealed view contains message 180 at the bottom and remains stable across subsequent samples.
- Frame analysis of the actual simulator recording confirms the last-message patch remains at the same pixel position in all 59 dark and 73 light frames captured during the first 1.3 seconds after reveal. No intermediate message position appears between the spinner and that first history frame.

Evidence: `output/chat-open-0920/Opening.xcresult`, `opening.mov`, `loading-to-latest.png`, `reveal-frames.jpg`, and `frame-review.json`. These are controlled simulator checks, not physical-device or production-network performance measurements.
