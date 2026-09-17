# Our desktop robot in native Swift

The character reference is **our OpenTeam desktop robot**. Grokbot is the reference for the surrounding mobile UI only. The earlier Grokbot character implementation was removed from the app, resources and tests; its working artifacts are archived outside the app under ignored `output/swift-bot-motion-0916/superseded-grokbot-port/`.

## Sources

- `packages/design-tokens/src/robot-avatar-artwork.ts`: all 12 vector designs, the `-4 -4 108 108` view box, face perspective and per-shape tempo.
- `packages/design-tokens/src/robot-avatar.css`: the actual desktop loops, gaze limits, blink fractions, part delays and reduced-motion behavior.
- `packages/design-tokens/src/robot-avatar-motion.ts`: the 320 ms live-pose bridge, destination-loop pausing, shared cursor continuity and interrupted transitions.
- `packages/contracts/src/robot-avatar.ts` and `bot-avatar.ts`: stored identities, normalization and picker colors.
- `packages/product-core/src/bot-avatar.ts`: activity belongs to the open conversation and the running/queued bot; other members idle and unrelated avatars remain still.

`bun apps/mobile-swift/scripts/export-robot-artwork.ts` generates the bundled `RobotArtwork.json` directly from those sources. `--check` fails if it is stale. Source SHA-256 values are embedded in that resource. The native client does not depend on JavaScript at runtime.

## Native implementation

`RobotArtwork.swift` decodes vector primitives and preserves canonical robot identifiers; unknown icons normalize to `chip` as on desktop. It does not map our stored robots to geometric Grokbot shapes. The picker exposes all 12 identities and the shared 11-color palette, including the light face for black robots.

`BotGlyph.swift` builds native Core Animation vector layers. It retains nested group opacity, rounded strokes, SVG transforms, fill-box anchors, and the desktop's perspective(300px) / rotateY(14deg) / translateX(2px) face transform. `RobotProjection.swift` reproduces SVG's flattened 2D matrix, including its perspective-induced shear and changing fill-box origin. A physical 3D layer is visually different and is not used. Body and face colors are independent of the surrounding light/dark theme.

`RobotMotion.swift` evaluates the desktop cubic-bezier(.42, 0, .58, 1) keyframes. Each animated part owns its loop clock. A mode change captures its currently presented pose, holds its destination loop, and bridges for 320 ms. An interrupted bridge starts from the interrupted pose. Unchanged loops, including the terminal cursor, retain their phase. Shape changes recreate the desktop identity; no invented shape morphs, spins or celebrations are added.

The CSS's absent animation fill mode is preserved: delayed dots remain invisible until their delays expire. Unspecified glow opacity endpoints use the original artwork's opacity. Reduce Motion cancels loops and bridges immediately and uses the original still artwork. Hidden/backgrounded views stop their display link; returning starts from still as desktop visibility handling does. Completed activity is retained for its 320 ms transition before the transcript row disappears.

## Evidence and limits

The browser fixture uses our actual shared artwork, CSS and transition controller. It records computed styles for **720 frames / 3,540 part poses** across all 12 identities, all three modes and 20 sample times. Native part matrices, opacity values, fill-box origins and 720 rendered face matrices are checked against those independently rendered browser samples. Tolerances are 0.00015 for part poses and 0.0002 for rendered face matrices, accounting for computed-style and timing-solver rounding.

Core tests also check canonical identities, interrupted transitions, destination-loop timing, the preserved cursor cycle and reduced motion. Simulator tests capture every robot in still and sampled thinking poses, light/dark appearance, a live transition tour, rapid reversals, and reduced motion/backgrounding. Integration tests exercise real native chat, keyboard, home, search and create flows against the isolated local fixture.

These checks establish matching artwork data and sampled motion behavior. They do not imply that Core Animation and a browser produce byte-identical antialiasing at every display scale. Inspect the same-size side-by-side view and the actual simulator movie under `output/swift-robot-parity-0916/`. Full-client physical-device and live-backend cutover gates remain in `PARITY.md`.
