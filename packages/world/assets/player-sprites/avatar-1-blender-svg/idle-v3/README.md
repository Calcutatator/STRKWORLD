# Avatar 1 — approved-concept idle draft

**Status: awaiting James’s separate idle approval.** Internal visual review and saved-master export verification passed on 2026-09-13.

This revision is based on the [fresh concept approved by James](../concept/avatar-1-concept-v2.png), SHA-256 `8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92`. His approval covers the concept. The four exported idle views require a separate approval before animation.

## Editable sources

The source uses authored curves and flat shading shapes guided by the approved concept. It does not trace a raster sprite. `source/front-back.json` and `source/profiles.json` record ordered shape paths and semantic part names; `source/design-contract.json` records the shared proportions, reference hash, palette and costume ownership. These paths are sampled into contours and authored through Blender MCP as native Grease Pencil fills in `source/avatar-1.blend`.

The saved Blender master includes the packed approved concept as an in-scene reference. Each native drawing has named layers and the shared 24-colour material palette. The four SVG files are actual Blender exports. PNG game cells are derived from those same SVG files, never independently drawn. Visible layers are editable; a complete animation rig and hidden surfaces remain later work.

[Blender master](source/avatar-1.blend) · SVGs: [down](svg/down/idle.svg), [left](svg/left/idle.svg), [right](svg/right/idle.svg), [up](svg/up/idle.svg).

[Exact idle preview](review/idle-approval.png) · [Concept comparison](review/reference-comparison.png) · [Smooth vector source preview](review/vector-source.png).

The first internal render needed changes to its eyes, hair, tunic hem, scarf and torso/leg balance. The original render and source are preserved in `review/iterations/01`. After silhouette revisions, one common coordinate correction across all views brought the waist, head and leg proportions closer to the approved concept. `review/proportion-registration.json` records that operation. Final path JSON already contains those coordinates; do not apply the transform again. Subsequent native-pixel eye and scarf refinements are documented in the visual QA record.

## Reproduce

1. Run `python3 source/build_geometry.py`. It verifies the approved concept hash and a pending idle decision before sampling the authored curves. It writes `source/idle-geometry.json` and `source/palette.json`.
2. In GUI Blender through MCP, set `AVATAR_SOURCE_DIR` to this revision's absolute `source` directory and execute `source/authoring.py`. It creates only the `AV1V3 | ` objects and scene, preserving the historical revision.
3. Execute `source/export_svg.py` through Blender MCP. This exports the current editable drawings and saves the master without rebuilding geometry. After manual Blender edits, use this exporter directly; rerunning authoring would restore the JSON recipe.
4. Run `node source/rasterize.cjs` using Node with Sharp and Sax available. It validates the native SVGs, writes the four 64×64 PNG cells, and verifies the review sheet contains exact 1×/2×/6× copies of those cells.
5. Reopen the saved master in Blender, execute `source/readback.py`, and run `python3 source/verify_source.py`. A source readback mismatch must be resolved or recorded as a new authored revision; it cannot be waived by the PNG preview.
6. Run `node source/make_reference_review.cjs` to prepare the approved-concept comparison. Review the exact exported cells against the concept and at native/game scale. Iterate before presenting the idle approval request.

Export framing stays fixed at 64×64 with feet at `(32,56)`. The rasterizer makes alpha binary using coverage ≥128 and maps opaque RGB to the nearest authored palette entry. It never fits or rescales individual silhouettes. Smooth source previews are explicitly separate from actual pixel output.

## Review scope

`review/qa.json` records SVG/PNG geometry, palette, transparency and exact preview parity. `review/source-parity.json` compares the reopened Blender source, exported SVG and shape recipe. `review/visual-qa.json` records likeness findings and iterations. `review/user-decisions.json` alone records the separate idle decision.

No animation, runtime replacement or game acceptance is included in this idle draft. Historical idle-v2 and the existing accepted runtime sprite remain preserved.
