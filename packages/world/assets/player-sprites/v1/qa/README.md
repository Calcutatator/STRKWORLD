# Avatar v1 QA evidence

The final art handoff was checked at native resolution before repository
staging. These checks validate the asset files, not World integration or
rendered in-game behavior.

## Mechanical result

`qa-report.json` records a passing scan of all 192 frames:

- 16 sheets at exactly 192x256 pixels;
- 3x4 cells at exactly 64x64 pixels;
- binary transparent alpha;
- no clipping on any canvas edge;
- lowest opaque pixel fixed at y=56 in every frame;
- no more than 24 RGB colors per frame;
- zero exposed bright-edge pixels at alpha boundaries;
- all idle, walk-1, and walk-2 frames distinct per direction;
- all down-facing idle frames pixel-identical to the approved calibration;
- art overlaps the fixed central gameplay-body reference;
- no detached bottom component matching a baked oval shadow.

`source-inspection.json` records the editable-source checks: 64x64 canvas, 192
frames, one `art` layer, 80 tags, 125 ms timing, and the two expected slices.

`aseprite-roundtrip.json` records a 16-sheet Aseprite round trip. Every PNG
re-exported from `source/player-sprites.aseprite` was pixel-identical to its
committed `avatar-N.png` counterpart.

## Visual evidence

- `all-characters-movement.png` shows every cosy and fighting frame on slate.
- `background-readability.png` shows all 16 down-facing idles on muted green
  grass, beige paving, slate road, and brick facade colors.
- `character-N-walk.gif` animates the cosy and fighting states together through
  all four facings at the recommended 8 FPS cadence.

Visual review also confirmed that characters 4 and 7 remain large, character 6
remains small, character 5 remains female, character 7 keeps the battle helmet,
and each fighting facing has one coherent weapon set without a duplicate
behind the character.
