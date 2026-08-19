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

## Approved final export contract

- Deliver 16 transparent 192x256 PNG sheets, one per opaque
  `avatar-1..avatar-16` key. Do not deliver a combined mega-atlas.
- Every sheet is exactly 3 columns x 4 rows of 64x64 cells: `idle`, `walk-1`,
  `walk-2` across and `down`, `left`, `right`, `up` down.
- Deliver one tagged editable Aseprite source alongside the PNG sheets.
- No frame contains baked shadow pixels. World may render one consistent
  shadow separately; it remains outside the sprite source and gameplay body.

James approved the 16 true-resolution idle calibrations on 2026-08-19. On
2026-08-20 he superseded the former mandatory pause after movement prototypes
for characters 1, 4, 6 and 7 and authorized the art lane to carry all eight
characters through final transparent exports, the tagged editable source,
mechanical QA and handoff. This is production authorization for the art lane;
it does not make this review package, an intermediate prototype or the final
handoff runtime-ready, and it does not authorize World integration or replace
rendered in-game acceptance.

## Final handoff destination

The approved production handoff belongs at
`packages/world/assets/player-sprites/v1/`, separate from this review package:

- `avatar-1.png` through `avatar-16.png` at the handoff root.
- `source/player-sprites.aseprite` as the one tagged editable source.
- `manifest.json` and `README.md` at the handoff root.
- Mechanical QA evidence under `qa/`.

This is a destination contract, not evidence that the final files exist, pass
QA, are runtime-ready or have been integrated. Keep every existing file in
`v1-review/` as review provenance; final production must not overwrite or move
this package.

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
- Final art must be redrawn or cleaned in the tagged editable Aseprite source,
  then exported through the approved per-key transparent sheet contract above.
- No code, scene, lobby, manifest, or loader integration has happened in this
  package.
