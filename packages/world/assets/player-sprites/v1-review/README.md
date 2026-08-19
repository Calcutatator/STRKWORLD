# STRKWORLD player sprites v1 review package

This package is the approved art-direction handoff for the first STRKWORLD
player-character set. It is **not** runtime-ready.

The approved direction contains eight selectable characters. Each character has
two paired visual states:

- `cosy`: default hub-world appearance, shown as the figure in the hidden
  avatar-changing room.
- `fighting`: the same character with adventure gear or a weapon in hand.

The current runtime art contract is one universal transparent 64x64 logical
canvas per frame, with the feet point fixed at `(32,56)`. Direction rows stay
in `down`, `left`, `right`, `up` order, and frame columns stay in `idle`,
`walk-1`, `walk-2` order. The cosy and fighting state for a character must use
identical canvas geometry, feet anchors, animation layout, and pair mapping.
The runtime-owned gameplay/contact body remains the common 24x24 footprint;
small characters stay visually small through transparent padding, while
characters 4 and 7 may occupy more of the 64x64 canvas. Atlas tooling may trim
transparent pixels only when it preserves 64x64 `sourceSize` and the fixed
feet pivot.

## Files

- `contact-sheet-approved-v2.png` - James-approved style direction.
- `master-sheet-labeled-v1.png` - labeled sprite-sheet draft for review.
- `master-sheet-clean-review-v1.png` - cleaner no-label sheet for art review.
- `manifest.json` - intended runtime structure and privacy-neutral pair mapping.
- `source/studio-notes.md` - creative names and character notes.
- `source/generation-source.md` - generation provenance and prompt notes.

## Known gaps before integration

- The generated PNGs are RGB and include a baked light checkerboard background.
  They are not transparent runtime assets.
- The sheets need exact 64x64 logical frame extraction with transparent alpha.
- Every frame needs manual `(32,56)` feet-position and pivot validation.
- Any final sheet should be redrawn or cleaned in an editable pixel-art tool
  such as Aseprite, then exported as transparent PNG.
- No code, scene, lobby, manifest, or loader integration has happened in this
  package.
