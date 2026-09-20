# Group avatar reference pass

Compared the four supplied group-avatar screenshots with the native list and chat header.

The previous Swift view drew only two bots in a diagonal stack everywhere. It had no silhouette separation, no overflow count, and ignored individual members' uploaded photos.

The updated implementation uses:

- A diagonal pair for two-member list icons, then three visible members in a 2×2 cluster with `+N` in the remaining position.
- A horizontal overlapping strip in the chat header, with `+N` after the third member.
- Transparent contour knockouts around foreground robots and the counter. The mask expands the actual vector artwork, including its animated parts. It does not paint a page-colored border over glass.
- Circular custom member photos, while a group's own custom image still takes precedence over the generated composite.
- A translucent tertiary counter label. Reference samples are approximately RGB 85 on the dark list canvas and RGB 107 on header glass; a single opaque gray would not match both.
- Actual total member counts, including members after the three rendered avatars. The empty/single-member states and wider, multi-digit counters remain supported.

Validation: eight core tests passed (group layout/counts and existing robot-motion checks). The GroupAvatars UI scenario passed in light and dark modes, capturing list counts 2/3/4/5/12 and headers for 2/5/12, and checking the accessible total and overflow count. It was repeated after the final counter color correction.

Evidence is in `output/group-avatar-0920/`: `FinalGroups.xcresult`, `core-tests.log`, full `groups-*.png` captures, and `group-avatar-comparison.jpg`.

The selected robot artwork is retained. The screenshots use legacy hexagon/pill marks while the fixture uses the current desktop chip/terminal robots. This comparison validates the group composition, cutouts, and overflow treatment; it is not a claim that different selected artwork has identical pixels. No TestFlight upload was performed.

## Centered chat headers

The avatar/title pill now occupies a centered middle slot between equal 44-point side slots. A group without a Computer action retains the empty trailing space, so removing that action cannot shift the pill. Long titles truncate within the middle slot. Native thread titles already use the centered inline navigation title.

`output/chat-header-center-0920/Headers.xcresult` passes ten header checks: group sizes 2/5/12 and short/long direct-message titles, in both light and dark mode. Each requires the pill's midpoint to match the screen midpoint within half a point, at least 7.5 points of clearance from the side controls, and a hittable details action. `centered-headers.png` contains crops of the actual simulator screenshots.
