# Attachment follow-up — September 21, 2026

This continues [the light/dark reply audit](LIGHT-DARK-REPLIES-0921.md) and
[the hypercritical follow-up](HYPERCRITICAL-0921.md). Changes remain local;
this pass does not change the TestFlight build or robot artwork.

## Fixed

- **Attachment menu:** the native UIKit menu now reads **Attach Image**, **Take
  Photo**, **Choose File**, with the reference symbols and a fixed top-to-bottom
  order. UIKit previously reversed bottom-anchored actions. The redundant voice
  menu action is removed; the composer's recording controls remain available.
  The camera action stays visible but disabled when the device has no camera.
- **Opened-photo resolution:** the gallery previously treated its initial
  960-pixel chat preview as a completed gallery load. It now upgrades from the
  same cached original to the gallery's 2048-pixel limit. The UIKit photo view
  also replaces its image when that upgrade arrives, preserving the zoom view.
- **Filmstrip thumbnails:** 48-point tiles now use separate 144-pixel images.
  They no longer disappear when an image leaves the 12-image full-size cache,
  and thumbnail requests no longer require a full gallery-sized decode.
- **Offline gallery return:** original file URLs survive decoded-image eviction.
  Returning to an already downloaded photo can decode the local original while
  offline. Page and filmstrip requests share the same original download.
- **Image preparation:** file writes and ImageIO downsampling run on the generic
  executor, outside the main actor. Pixel decoding completes there before the
  image reaches UIKit. This removes synchronous image preparation from the UI
  path; it is not an FPS benchmark.
- **Invalid image recovery:** a successful HTTP response with invalid image bytes
  no longer pins a bad cached gallery source. Retry can fetch corrected bytes.
  Canceled preparation and session changes also discard unfinished local files.

## Evidence

Artifacts: `output/attachments-followup-0921/`.

- `index.html`: original simulator captures and the menu comparison.
- `attachment-menu-comparison.png`: reference / before / updated, displayed at
  equal width. No source image colors are adjusted.
- `reference-provenance.json`: reference path and SHA-256.
- `*-source-state.json`: source hashes recorded before each final build.
- `*-summary.json`, `*-tests.json`, and `*.xcresult`: test results, including
  unsuccessful runs rather than only the final successes.
- `capture-manifest.json`: exported attachment paths and hashes.

The first baseline's software keyboard was off-screen despite being present in
the accessibility tree. It is valid evidence for menu labels/order, but not for
keyboard layout. The menu tests now require the keyboard to be visibly inside the
screen. A fresh dedicated iPhone 16 Pro Max / iOS 26.5 simulator was used after the
original simulator shut down during a run.

The long-gallery test also exposed two test problems: querying `isHittable` on a
virtualized off-screen tile could abort XCTest's subsequent gestures, and counting
downloads before initial chat loading finished included late timeline requests.
The test now waits for chat loading to finish and checks tile geometry before
interacting. The settled download receipts show one additional original request
for each of photos 1–23 during the gallery traversal.

## Visual limits

The menu's text, symbols, action order, and three-row layout now follow the supplied
reference. Its native system material remains darker and its leading inset is
larger than the reference. These differences are visible in the comparison; this
is **not** a pixel-perfect parity claim. The reference keyboard also has a Siri
suggestion row absent from the simulator capture. Camera capture and physical
haptics require device validation. The tests here use an inert HTTP fixture, not
production APNs, OAuth, transcription, or live VNC.

## Validation

The complete core suite passes: **100 tests**. All **11 distinct targeted simulator
checks** have passing final results (`Final`: 10, `Recheck`: 2 repeated file/retry
checks, `GalleryFinal`: 1 stress check). Simulator checks cover native
Photos/Files picker cancellation with draft preservation in both themes,
file preview and sharing in both themes, gallery paging/zoom/forwarding,
Photos save/share, HTTP-error and invalid-byte retry, attachment hold/swipe
replies, reference Markdown, recording controls, keyboard/send/activity motion,
and one haptic cue for opening the attachment menu. The 24-photo stress check
verifies visible thumbnail pixels, one gallery download per original, and
successful offline return to the first photo after decoded-image eviction.
It passes in `GalleryFinal.xcresult`; the original unsuccessful runs are retained
alongside it. The dedicated simulator was shut down and fixture processes stopped
after validation. No other running simulator was shut down.
