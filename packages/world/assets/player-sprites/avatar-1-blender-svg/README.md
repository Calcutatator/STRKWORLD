# Avatar 1 — Blender MCP and SVG workflow

**Active authoring flow, directed by James on 2026-09-12.** The preceding
ImageGen/reduction draft was rejected for its in-game appearance. Restart at
the first idle approval gate using editable vectors. This workflow is recorded
in [D-059](../../../../../docs/DECISIONS.md#d-059--avatar-1-authoring-uses-blender-mcp-and-real-svg-pose-files).

## Source and output

Use Blender MCP to author a layered Grease Pencil character and pose it in
Blender. Save the `.blend` as the editable animation master. Export each pose
as a real, editable SVG containing vector paths and fills. Rasterize those
same SVGs directly at 64×64 for the existing PNG sprite runtime. The deliverable
includes both the `.blend` and the SVG files; Blender renders are not a second,
unrelated approval path.

Working layout (only idle sources, frames and review are populated so far):

```text
source/avatar-1.blend
source/authoring.py
source/palette.json
source/blender-environment.json
svg/down/idle.svg
svg/left/idle.svg
svg/right/idle.svg
svg/up/idle.svg
svg/<direction>/<pose>.svg
frames/<direction>/<pose>.png
review/idle-approval.png
review/<direction>-walk-preview.*
review/qa.json
review/user-decisions.json
export/avatar-1.png
export/manifest.json
```

**Current draft: idle-v1, awaiting James's approval.** Four fresh layered
Grease Pencil views, four native SVGs and their exact 64×64 PNGs now exist.
The [approval sheet](review/idle-approval.png) shows the final pixels at 1×,
2× and 6×. The editable [Blender master](source/avatar-1.blend) contains named
parts for all views. No rig or walk animation has been created yet. The
`setup/` directory remains a separate export fixture, not avatar artwork.

SVG sources: [down](svg/down/idle.svg), [left](svg/left/idle.svg),
[right](svg/right/idle.svg), [up](svg/up/idle.svg).

## Ordered stages

1. **Connect and prove export.** Make Blender and Blender MCP available.
   Record actual versions and a live scene-inspection result. Create a small
   vector export probe through MCP; export an active Grease Pencil frame to
   SVG, inspect its paths/fills, then rasterize at 64×64. Verify transparency,
   colour, framing and layer order. Do not author the character until this
   installed-version path works. A configured MCP server alone is insufficient.
2. **Author the four idle views.** Rebuild the medium-size Teal Scarf Runner
   with named parts for hair, face, scarf, torso, arms, hands, satchel, legs
   and boots. Keep the established brown hair, teal clothing and leather
   equipment. Use deliberate shapes and a small authored flat-colour palette.
   Inspect actual 64×64 exports continuously while drawing. Do not reproduce
   the rejected bitmap by tracing it or putting it inside an SVG.
3. **First user approval.** Present down/left/right/up together, with editable
   SVGs available and their exact 64×64 PNGs shown at 1×, 2× and enlarged
   nearest-neighbour scale. Review faces, proportions, silhouette and accessory
   continuity. Wait for James's explicit approval of the small outputs.
4. **Rig and animate one direction.** Reuse the accepted construction in a
   Blender rig with named pivots and controlled part deformation. Author
   contact, passing and settle poses as coherent whole-body movement. Keep
   facial identity, planted-foot logic, counter-swing and scarf follow-through.
   Export the six poses as separate SVGs and derive all PNGs/previews from
   them. Review the complete loop at the runtime cadence before extending it.
5. **Complete the other directions.** Author direction-specific views/poses,
   maintaining scarf and satchel ownership. Do not mirror asymmetric features
   blindly. Any material idle redesign returns to the idle approval gate.
6. **Export and verify.** Produce the exact 24-frame Avatar 1 sheet, source
   files and source/export hashes. Re-export from `.blend` and re-rasterize
   from SVGs to prove reproducibility. Fixes to an SVG must be represented in
   the Blender source or a recorded, repeatable vector-edit step. Record
   mechanical checks, visual findings and user decisions separately.
7. **Game acceptance.** Only after the art handoff is approved, integrate via
   the World lane and give James a short current-checkout browser test. Asset
   review is not live Phaser acceptance.

## Vector and game contract

- Self-contained SVG with an explicit 64×64 viewport/viewBox after recorded
  framing conversion, real paths/fills and editable named parts where the
  exporter preserves them; semantic part names remain in the Blender master.
- No embedded raster `<image>`, external fonts/images, raster filters or
  pixel-by-pixel tracing of the rejected PNG. Avoid hairline strokes and tiny
  decorations that disappear at game size.
- Use consistent orthographic framing and a registered feet pivot `(32,56)`.
  Export preserves transparent padding. Normalize the character's framing
  once, not the height of every animation frame; body bob and lifted feet
  must survive.
- Runtime remains four direction rows `down`, `left`, `right`, `up`, six
  columns `idle`, `contact-left`, `passing-left`, `contact-right`,
  `passing-right`, `settle`: 384×256 PNG, 64×64 cells, 24×24 gameplay body,
  8 FPS walk and 12 FPS sprint. No runtime SVG loader or geometry change is
  part of this authoring change.
- Design the palette and pixel-size edges in the source. Final outputs still
  need binary alpha, no baked shadow and the existing palette constraint.
  SVG rasterization can add antialiasing: inspect it, and record any necessary
  deterministic export treatment before asking for approval. Do not silently
  quantize or threshold an already approved image. SVG alone does not prove
  that a 64×64 face or walk looks good.
- Every review image and loop must use the final PNG cells from the exported
  SVGs; check crop parity, file hashes and timing. Mechanical success must
  never promote a rejected or pending artistic decision to approved.

## Tooling evidence and current availability

Blender's [Grease Pencil SVG exporter](https://docs.blender.org/manual/en/5.0/files/import_export/grease_pencil_svg.html)
documents frame export, fills and stroke sampling. Its Object Mode/viewport
requirements mean that the selected view, aspect and framing must be explicit
and verified on the installed version. The
[Grease Pencil armature modifier](https://docs.blender.org/manual/en/5.0/grease_pencil/modifiers/deform/armature.html)
supports rig deformation. A generic shaded 3D render is not automatically a
filled-vector SVG equivalent; this flow starts with vector artwork.

The [Blender MCP implementation reviewed](https://github.com/ahujasid/blender-mcp)
provides scene inspection, Python execution and viewport screenshots through
an MCP server plus a Blender add-on. Use local authoring and
`DISABLE_TELEMETRY=true` when configuring this implementation. Asset-generation
services and external models are unnecessary for this flow.

**Setup completed on 2026-09-12:** Blender 5.2.1 LTS is installed at
`/Applications/Blender.app`, with the `blender` command on PATH. The pinned
`blender-mcp` 1.9.1 package and matching add-on are installed; Codex's `blender`
MCP entry uses a dedicated Python 3.11 environment. The enabled add-on starts
its socket automatically when GUI Blender opens. It listens only at
`127.0.0.1:9876`. Both telemetry environment opt-outs are set and the saved
Blender telemetry-consent preference is false.

A real MCP stdio session verified protocol 5, Blender/add-on versions, scene
inspection and command execution. It created a separate native Grease Pencil
fixture, exported a 64×64 SVG containing 28 paths and zero embedded images,
saved the `.blend`, and read back the scene. The SVG rendered to a nonempty
transparent 64×64 PNG. Its 151 partial-alpha edge pixels are ordinary vector
antialiasing, not a production sprite alpha pass. The source and outputs are
recorded in [`setup/setup-report.json`](setup/setup-report.json).

**Restart verified, 2026-09-12:** the task's native Blender tools are now
available. `get_addon_status` reported Blender 5.2.1 LTS, protocol 5, matching
add-on and telemetry consent false. Native MCP calls authored the four views,
exported them, saved the master, reopened it and re-exported existing geometry.
Keep GUI Blender open while using MCP.

For setup recovery and exact local paths, see [`setup/README.md`](setup/README.md).

The machine-readable stage state is [`workflow.json`](workflow.json).

## Reproduce and inspect the idle draft

In GUI Blender, run `source/authoring.py` through Blender MCP with
`AVATAR_SOURCE_DIR` set to this directory's absolute `source` path to rebuild
from the original vector recipe. It replaces only `AV1SVG | ` scene/objects.
**Do not run the authoring script to export hand-edited Blender artwork**:
it reconstructs that named artwork from the recipe.

Run `source/export_svg.py` to export the existing Grease Pencil geometry and
save the master. It reasserts frame 1, square pixels, the 64×64 orthographic
camera and the largest 3D view. Run `node source/rasterize.cjs` to derive the
PNG cells and review sheet from those SVGs. The script uses bundled Sharp;
`STRKWORLD_NODE_MODULES` can point to another module directory containing
`sharp` and `sax`. `python3 source/verify_vectors.py` verifies the original
recipe, saved-master readback, SVG paths/materials and recorded hashes.

The export treatment is explicit and applied **before this draft's approval**:
SVG is rasterized at the authored 64×64 size, alpha coverage below 128 is
removed and other alpha becomes 255, then RGB maps to the closest of the 24
authored colours. The PNG has no baked shadow. No individual view is fitted
or rescaled. All visible feet end at row 55, for the y=56 contact line.
Front/side hair silhouettes are 50px tall; the back is 49px after rasterization.

Blender 5.2 needs a nonzero `fill_id` for each painted polygon and
`hide_stroke=True` to export fills without unwanted rings. The SVG exporter
ignores `material.show_stroke=False` for this purpose. This was verified
against the installed API and actual exports. Native sRGB export truncates
some channels by one; source parity allows at most one level per channel,
while the PNG uses the exact authored palette.

[Mechanical QA](review/qa.json) checks dimensions, transparency, palette and
pixel-exact preview crops. [Source parity](review/source-parity.json) checks
vector construction. [Reload parity](review/reload-parity.json) records
byte-identical SVG and PNG files after reopening the saved `.blend` and
exporting without rerunning the authoring script. These establish local
source/export mechanics, not artistic approval or live-game acceptance.

The face review corrected tall pale eye shapes by separating small dark pupils
from the fringe. The scaffold keeps medium proportions, crossed leather
harness and anatomical-left scarf tails plus a small hip pouch. The remaining
art decision is James's review of the four exact idle cells.

`review/user-decisions.json` is the explicit approval record. The rasterizer
only writes when its status is `pending`; an approved or rejected review must
be preserved and a new revision explicitly started before changing pixels.
Animation, full-sheet delivery and game integration remain later gates.
