# Avatar 1 — rebuilt idle draft v4

**Withdrawn and unapproved.** Renewed inspection found that the face and
proportions in these exported PNGs still fall below the approved concept.
The prior aesthetic pass and approval request are withdrawn. The
[review](review/idle-approval.png), [concept comparison](review/reference-comparison.png),
sources, exact hashes and technical checks remain historical evidence;
[the QA record](review/visual-qa.json) preserves the earlier assessment and
its correction. This revision was never integrated or inspected inside the
live game. No idle approval, animation approval or game acceptance exists.

The exact approved concept-v2 remains the appearance authority. Further
refinement awaits clarification between preserving the crisp illustrated
concept look and deliberate low-resolution pixel art; current runtime
presentation and resolution constraints are under investigation. No
replacement method, revision or ready candidate is claimed.

The initial fine-detail reference again lost its eyes and expression when
reduced to a 64-pixel cell, so it failed internal review. A second, deliberately
coarse game-art construction study gives the face, materials and pose larger
readable shapes. Its head/body registration is adjusted for the game's scale.
The source records explicit corrections to the final colour-index design.

This is **image-assisted vector reconstruction**. ImageGen supplied new
construction references using the approved concept; it did not supply the
runtime PNG exports. The indexed design is reconstructed into contiguous
filled vector contours with semantic editing groups, authored as native
Grease Pencil through Blender MCP, saved in `source/avatar-1.blend`, and
exported with Blender's native SVG exporter. The final 64 × 64 PNG cells are
rasterized from those SVGs. SVG files contain actual paths, with no embedded
raster image or external resource.

The packed concept is labelled approved. Packed construction studies are
separately labelled internal and unapproved. The `.blend` preserves editable
visible colour regions; it is not yet an animation rig and has no invented
hidden-surface or walk-cycle acceptance.

## Sources and reproduction

- `source/art-palette.json`: shared authored palette, at most 24 colours.
- `source/artist-grid.json`: exact editable colour-index design and recorded
  pixel edits, with concept/study hashes and explicit registration.
- `source/idle-geometry.json`: contiguous vector boundaries derived from the
  design; semantic partitions do not change the pixels.
- `source/avatar-1.blend`: native Blender Grease Pencil master with packed
  approved concept and clearly labelled construction references.
- `svg/{down,left,right,up}/idle.svg`: native Blender pose exports.
- `frames/{down,left,right,up}/idle.png`: derived 64 × 64 runtime cells.

These withdrawn historical assets cannot be overwritten by the construction tools. Start a
new internal revision for further art changes. In an internal revision, run `source/grid_from_studies.cjs`, then
`source/refine_grid.cjs` and `source/apply_head_refinement.cjs`,
then `source/trace_grid.py`. Use the native MCP author/export/reopen/readback
sequence in [source/README.md](source/README.md). Run `source/rasterize.cjs`,
`source/verify_source.py` and `source/verify_pixels.cjs` after the export.
`source/make_comparison.cjs` creates the concept comparison from actual PNGs.
All Node scripts use the configured bundled Node/Sharp runtime.

## Quality checks

`review/source-parity.json` checks actual reopened Blender geometry, materials,
SVG contours and saved-master hashes. `review/pixel-parity.json` checks every
PNG pixel against the explicit colour design. `review/qa.json` verifies
framing, alpha, palette and exact 1×/2×/6× review crops. These are technical
checks only; none establishes that the art is good.

Before any approval request, inspect the actual exported cells at 1× and 2×
and against the concept. Check whether the character looks appealing,
expressive and coherent in all four facings. Rough construction, rigid posing,
muddy colours, flat profiles or loss of identity require continued internal
refinement. Do not ask James to discover those defects. The first v4 check
kept the revision internal because front/right faces lacked expression and
hair highlights were fragmented; `review/visual-qa.json` records subsequent
inspection, the withdrawn pass and the renewed failure.

The accepted runtime asset remains untouched. No browser automation,
animation, runtime integration or production delivery is implied.
