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

Suggested working layout, to be populated during authoring:

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

These paths are a delivery contract, not claims that assets already exist.
No `.blend`, SVG avatar, Blender render or animation has been produced yet.

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

Checked on 2026-09-12: no callable Blender MCP tool in this task, no Blender
server in the inspected Codex MCP configuration, no `blender` on PATH and no
Blender app at the standard system or user Applications locations. Setup and
the live SVG export probe are therefore pending. No Blender/MCP installation,
scene creation, rig, SVG export or export-parity claim has been made.

The machine-readable stage state is [`workflow.json`](workflow.json).
