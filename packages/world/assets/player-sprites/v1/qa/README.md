# Player sprite QA

This evidence covers the D-052 corrected art handoff, including the bounded
character 5/13 cross-facing identity correction. It has passed independent
orchestration review. World runtime integration remains separately committed
at `5c8c81a`; this is not a runtime-ready or rendered-acceptance claim.

Checks run over all 16 sheets and all 320 frames:

- 320x256 sheet dimensions with 20 transparent 64x64 cells per sheet.
- Binary alpha only, no baked shadow pixels, and fixed last opaque row `y=56`.
- At most 24 visible RGB colours per frame.
- Exterior flood-fill found zero enclosed transparent islands.
- Body-corridor scan found zero missing upper-torso or pelvis-to-foot corridors.
- Narrow 1-2px body-channel scan found zero unapproved channels. Stable lower-leg
  separation and the large warrior's helmet-horn gap are explicitly whitelisted.
- High-luma boundary scan found zero exposed white/cyan matte-fringe pixels.
- Whole-body gait diff passed all 256 non-idle cells: every contact/passing frame
  changes from its directional idle at or above the 65% idle alpha-bbox hip gate;
  changed pixels range from `y=8..27`, so motion is not confined to feet.
- Independent orchestration review additionally found at least 243 changed
  pixels above each cell's hip gate and at least 60.8% of each cell's total
  changed pixels above that gate, rejecting token upper-pixel changes.
- Side-facing idle silhouettes are vertically normalized to each character's
  approved down-facing model; characters 4 and 7 remain large and character 6
  remains the deliberately small female mechanic.
- `cross-facing-identity.json` checks height, top line, feet line, size class,
  and the shared down-facing model rule across all 16 keys. The character 5/13
  side rows are rebuilt from that shared model while retaining the authored
  direction-specific staff.
- Deterministic contrast contacts cover black, white, mid-grey, and muted grass.
- Aseprite inspection verified one `art` layer, 320 frames at 125ms, 16 key tags,
  two slices, and the `(32,56)` pivot. Re-export reconstruction matched all 16
  PNG sheets pixel-for-pixel.

The only permitted negative space is stable, anatomically readable leg
separation or the reviewed horn gap. No gap is concealed by a background,
shadow, scaling rule, or runtime collision geometry.
