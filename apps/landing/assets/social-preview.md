# Social preview artwork

The homepage, download page, and installer source page share the current brand card, with their own page titles, descriptions, and canonical URLs. Metadata lives in `lib/page-metadata.ts`.

- Active asset: `public/social/openteam-2026-09-13.png` (1200 × 630).
- Legacy fallback: `public/og.png` contains the same artwork.
- Generation: built-in `image_gen` tool, using `apps/mobile/assets/openteam-icon.png` as the brand reference. Resized to the final share dimensions with `sips`.
- When replacing the artwork, use a new image filename and update the metadata URL so crawlers can fetch a fresh asset. Also replace the legacy fallback.

## Final generation prompt

```text
Use case: ads-marketing.
Asset type: crisp professional OpenTeam landscape social-preview raster card for iMessage, X, and Slack.
Create ONE complete finished card, exactly 1200 by 630 pixels, 1.9047619:1 landscape aspect ratio. Higher resolution is fine only at this same aspect ratio.
Input image 1 is the official OpenTeam robot brandmark reference, not a layout reference. Preserve its identity faithfully: flat 2D teal rounded-rectangle head, single central antenna with circular tip, near-black horizontal face pill, exactly two teal circular eyes, and exactly three small near-black rounded mouth bars. Preserve its subtle native teal gradient. Do not redesign, render in 3D, or add a body.
Background: clean white with an extremely faint, evenly spaced square grid across the entire canvas; sophisticated and barely perceptible. No blobs.
Composition: all content within 60px safe borders. Spacious typography-led composition. At top left, a small faithful teal robot icon followed by the exact black wordmark "OpenTeam" in modern clean Geist/Inter-like sans serif. Main copy on left, set in large heavy modern sans serif with careful kerning, exactly two lines:
"Run your own"
"AI team."
Use black for first line and medium gray for second line. Below this headline, one legible supporting line in dark gray: "Digital workers on your compute."
Bottom left, smaller dark-gray text: "Open source. Self-hosted."
Bottom right, smaller dark-gray text: "openteam.so"
Right half: one larger faithful 2D teal robot icon from the reference, visually balanced with the headline. It has no enclosing tile or frame, no shadows, no cartoon body, no arms, no legs. Reference icon itself is the subject. Brand reference's light square background must not become a tile.
The only text in the image must be exactly the six quoted text items above; headline has exactly the two specified lines. Correct capitalization, spelling, punctuation. Strong legibility at small shared-image widths. Crisp edges, deliberate whitespace, premium restrained open-source technology branding.
Avoid: 3D, photorealism, decorative blobs, shadows, badges, buttons, terminal commands, browser frame, website screenshot, old serif type, extra text, watermarks.
```
