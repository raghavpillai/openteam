# Attachment menu glass — September 21, 2026

Follow-up to [the attachment audit](ATTACHMENTS-FOLLOWUP-0921.md). This pass
addresses its remaining menu material and leading-inset differences. Changes
remain local; no TestFlight upload or robot-artwork changes.

## Change

The attachment button now opens a native SwiftUI glass panel hosted as a UIKit
child controller. The previous `UIMenu` controlled its own material and position:
its resting dark fill was substantially darker than the supplied reference and
its leading inset was 18 points rather than approximately 8.

The panel uses a 250-point width, 42-point minimum rows, 10-point vertical padding,
32-point continuous corners, and 17-point symbols. Labels remain Attach Image,
Take Photo, Choose File. Native Photos/Files/camera presentations remain intact.
The camera action remains disabled on devices without a camera.

The presentation leaves the composer first responder and overlays the existing
layout without changing its keyboard inset. It supports outside dismissal,
accessibility escape, one opening haptic, Reduce Motion, and scaled row heights.
It removes its child controller on dismissal, source removal, or app backgrounding.
It also respects the parent's disabled environment while chat loading is pending.
No private UIKit hierarchy or menu APIs are used.

The final blank dark-surface sample is RGB **47/47/47**, versus **48/48/48**
in the reference and **26/26/26** in the previous pass. The horizontal inset
is now 8 points. The reference JPEG suggests approximately 8.2 points.

## Evidence and limits

Artifacts: `output/menu-glass-0921/`. `menu-comparison.png` shows the reference,
previous pass, and new implementation at equal display scale. Original captures,
source hashes, recordings, exported attachments, and test results are retained.
`measurements.json` samples a blank upper-right menu region, excluding the label,
rim, and composer backdrop. This is a local color measurement, not a whole-image
similarity score. Source image colors have not been adjusted.

The reference is a downscaled JPEG; the simulator captures are PNGs. Width is
normalized to 440 points. The reference top edge is at source y=609 of its
589-pixel-wide image. Crops align each panel's top edge to compare its geometry.
Absolute vertical position also depends on the keyboard suggestion area: the
reference has a Siri row absent from this simulator.

The surface is considerably closer, but native blur/refraction and the rim still
vary with the content behind them. There is no matching light-mode attachment
menu reference in this particular screenshot set; light mode is verified for
layout and interactions, not certified pixel parity. The opening animation uses
a short fade/scale transition; the static attachment reference cannot establish
its exact timing. Camera capture, physical haptic strength, VoiceOver navigation,
and hardware keyboard Escape still need device acceptance.

## Validation

The dedicated iPhone 16 Pro Max / iOS 26.5 simulator uses inert HTTP fixtures.
Checks cover visible keyboard retention, Photos/Files picker cancellation and
draft preservation in both themes, repeated outside dismissal without vertical
movement, typing afterward, menu presentation without a keyboard, background
cleanup, exactly one opening haptic event, and keyboard/send/activity transitions.
These checks do not substitute for live-server APNs, OAuth, transcription, or VNC
acceptance. No Core behavior changed in this pass; the preceding 100-test Core
result remains recorded in the attachment audit.

Final result: **6 tests passed, 0 failed** in `Verified.xcresult`. `Probe` and
`Final` also passed, but predate the final symbol/tint refinement. Final source
hashes match the tested build. `opening-sequence.png` contains six actual recorded
frames across 297 ms; the sampled surface rises progressively during the fade.
This is an animation inspection, not an FPS benchmark or reference timing match.
Owned fixture processes were stopped and the dedicated simulator restored to
Shutdown. Other simulators and the TestFlight build were left unchanged.
