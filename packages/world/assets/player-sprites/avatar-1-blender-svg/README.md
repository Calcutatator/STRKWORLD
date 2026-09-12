# Avatar 1 — concept, Blender MCP and SVG workflow

**Active revision: idle-v2.** James rejected both the September 12 raster
restart and the hand-drawn `idle-v1` SVG draft. The latter's visual QA was too
permissive: successful export did not establish a close match to the concept.
See [D-059](../../../../../docs/DECISIONS.md#d-059--avatar-1-authoring-uses-blender-mcp-and-real-svg-pose-files).

The existing [approved concept turnaround](reference/approved-concept-turnaround.png)
is now the construction source and visual authority. No new concept image was
generated for this revision. The darker old runtime idles are useful for scale
comparison, but are not tracing sources. Neither rejected draft is an art source.
Provenance is recorded in [reference-manifest.json](reference/reference-manifest.json).

## What to review

The [reference comparison](review/reference-comparison.png) pairs the approved
concept with each SVG-derived sprite at equal visible height. The
[exact-cell sheet](review/idle-approval.png) shows the actual transparent 64×64
PNG cells at 1×, 2× and 6×. The latter is the pixel output that approval covers.

Editable sources: [Blender master](source/avatar-1.blend),
[down SVG](svg/down/idle.svg), [left SVG](svg/left/idle.svg),
[right SVG](svg/right/idle.svg), [up SVG](svg/up/idle.svg).

This is a vector reconstruction of existing approved concept art. Contiguous
colour regions become actual Grease Pencil polygons, including compound paths
with holes. Visible regions have named editing groups. This is not a claim of
a newly designed character, clean anatomical rig, completed hidden surfaces or
animation. Those later stages must preserve the approved idle pixels.

## Reference-first production sequence

1. Establish the concept and its provenance before building the sprite. Keep
   it beside the work throughout QA. Compare the actual hair locks, face,
   shoulders, torso/leg proportions, scarf, harness, gloves and boots.
2. Register the concept to the game cell once. Inspect sampling and palette
   studies before vector construction. Check that narrow dark pupils and
   white sclera survive. Exterior background removal must not erase enclosed
   white facial details. Keep the raw concept crops for comparison.
3. Construct the four views in Blender through MCP and export real SVG paths.
   Rasterize those SVGs and demand exact RGBA parity with the chosen
   construction cells. Vector reconstruction must not introduce drift.
4. Perform **reference-fidelity visual QA** on the actual exported sprites.
   Compare all four directions side by side with the concept at equal visible
   height, and inspect 1×/2× game-scale readability. A generic anatomical or
   coherence pass is insufficient. Iterate internally until close before
   asking James for approval. Preserve specific failures and their fixes.
5. Ask James to approve the four exact idle views together. Record the result
   separately from internal visual review and mechanical QA. No animation
   until explicit user approval of this gate.
6. Build proper direction-specific rig/part ownership and hidden surfaces.
   Author one complete walk direction, including whole-body weight transfer,
   counter-swing, foot contact and scarf follow-through. Review the whole loop
   before extending it to the other directions. Material idle changes reopen
   idle approval.
7. Export all 24 poses, verify SVG/PNG/sheet/preview parity, then request the
   separate art handoff approval. Game integration and James's browser
   acceptance remain later World-lane work.

## Reproduce the source and exports

- `reference/studies/study.cjs` reads only the approved concept. It preserves
  raw crops, compares resampling methods, selects source-aligned sampling
  phases and a shared palette of up to 24 source-derived colours. The report
  records source hashes, segmentation, scale, phases and foot registration.
- `source/freeze_construction.py` copies the selected study cells to
  `source/construction/` and freezes their provenance. Run only after the
  construction study has been visually inspected.
- `source/build_reference_vectors.py` traces the boundaries of contiguous
  colour regions with holes. Run with a Python environment containing Pillow.
  It writes `source/idle-geometry.json` and `source/palette.json`.
- In GUI Blender, run `source/authoring.py` through Blender MCP with
  `AVATAR_SOURCE_DIR` set to this directory's absolute `source` path. It
  replaces only `AV1SVG | ` scene/objects and reconstructs the source polygons.
  **Do not use this to export hand-edited art**; it rebuilds from the recipe.
- `source/export_svg.py` exports existing geometry and saves the `.blend`.
  It reasserts frame 1, the 64×64 orthographic camera, square pixels and the
  largest 3D viewport. `source/readback.py` reads the saved/reopened geometry
  for independent comparison.
- `source/rasterize.cjs` derives the final PNG cells and exact-cell sheet from
  the native SVGs. It uses Sharp and Sax; set `STRKWORLD_NODE_MODULES` to a
  compatible module directory if the recorded bundled runtime is unavailable.
- `source/make_reference_review.cjs` places the actual exported PNG cells next
  to the original concept crops, without changing the exported pixels.
- `source/verify_vectors.py` independently checks compound paths, source
  coverage, native palette colours, Blender readback and exact decoded PNG
  equality to the construction cells. The supplied reopened-master report
  must match current artifact hashes.

All construction cells have binary alpha. The integer-aligned region paths
export back to those same pixels. The rasterizer's explicit alpha threshold
(128) and nearest-palette mapping remain recorded, but are not used to hide a
geometry or colour mismatch: zero pixel difference is required afterward.

Blender 5.2 requires a nonzero `fill_id` for each filled region; multiple
boundary loops for its holes share the same id. Set `hide_stroke=True` to
suppress unwanted rings. `material.show_stroke=False` alone is insufficient.
The native exporter truncates sRGB bytes: a documented quarter-byte material
bias puts each colour inside the intended integer bin and gives the exact
palette hex. These details were checked against the installed API and actual
exported artwork.

## Contracts and evidence

The runtime contract remains 64×64 cells, a feet contact line at `(32,56)`,
a 24×24 gameplay body, down/left/right/up rows, six columns (idle,
contact-left, passing-left, contact-right, passing-right, settle), 8 FPS walk
and 12 FPS sprint. No new runtime SVG loader is part of this work. The
previously approved runtime PNG remains unchanged.

The concept sampling uses one common scale and recorded direction-specific
subpixel alignment. Each initial idle is registered to last opaque row 55.
Never normalize each animation frame's visible height; that would erase body
bob and lifted feet. SVGs contain real flat-colour paths, no embedded raster,
external resources, filters or fonts. No baked shadow is present.

Evidence and decisions have separate roles:

- `review/qa.json`: dimensions, alpha, palette, exact-cell preview crops.
- `review/source-parity.json`: construction regions, SVGs, readback and RGBA.
- `review/reload-parity.json`: reproducibility after reopening the saved master.
- `review/visual-qa.json`: specific reference comparisons, failed iterations
  and final internal visual assessment. This is not James's approval.
- `review/user-decisions.json`: explicit user approval/rejection for this
  revision, bound to the reviewed hashes. The rasterizer only writes while
  this is pending. Preserve approved/rejected revisions before changing art.
- `review/rejected-idle-v1/`: presented image and user rejection; the complete
  old source is preserved at commit `110b26e`.

## Blender setup

Blender 5.2.1 LTS and pinned Blender MCP 1.9.1 are installed. After James's
Codex restart, native tools connected and reported protocol 5, a matching
add-on and telemetry consent false. Keep GUI Blender open. MCP listens on
`127.0.0.1:9876` and both telemetry opt-outs are configured.

[Setup instructions](setup/README.md) and [setup evidence](setup/setup-report.json)
cover installation and the separate Grease Pencil monkey export fixture.
That fixture proves tooling only, not avatar quality. The current stage state
is in [workflow.json](workflow.json).
