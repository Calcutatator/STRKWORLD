# Avatar 1 — concept approval, Blender MCP and SVG workflow

**Active stage: fresh concept art, followed by explicit user concept approval.**
James corrected the process: the old turnaround was not concept art. We must
create a fresh concept and obtain his approval before producing Blender/SVG
sprites. `idle-v2` is superseded and unapproved because this gate was skipped.
See [D-059](../../../../../docs/DECISIONS.md#d-059--avatar-1-authoring-uses-blender-mcp-and-real-svg-pose-files).

## Current review and authority

The [fresh concept candidate](concept/avatar-1-concept-v2.png) is ready for
review, with its pending decision in [concept/approval.json](concept/approval.json).
Internal review corrected scarf and buckle continuity before this candidate.
The decision record binds any approval to the actual reviewed image. Concept creation is not concept approval. No concept has been approved
for this restart, and no Blender character production may proceed until James
explicitly approves one.

`reference/approved-concept-turnaround.png` is a historical sprite turnaround,
not an approved concept. Its misleading old filename is retained to preserve
provenance and links, not to confer authority. Do not use it, the rejected
raster restart, `idle-v1` or `idle-v2` as art sources for the fresh concept.
[The reference manifest](reference/reference-manifest.json) records this
correction. The currently accepted runtime asset remains unchanged.

The existing [reference comparison](review/reference-comparison.png),
[exact-cell sheet](review/idle-approval.png), [Blender master](source/avatar-1.blend)
and SVGs under `svg/` all belong to **historical idle-v2**. Their captions
predate the correction. They are not active approval requests or approved
concepts; their hashes and technical results remain historical evidence only.

## Required production sequence

1. **Create fresh concept art.** Produce a new character design proposal for
   Avatar 1 from the current brief. Present the concept itself, with enough
   detail to judge face, hair, proportions, clothing, equipment and overall
   character. Do not substitute a sprite sheet, resampled prior turnaround
   or vector conversion for this stage.
2. **Obtain explicit concept approval.** Ask James to approve the fresh
   concept and record the decision against its file hash in
   `concept/approval.json`. If he requests changes, revise the concept and
   return to this gate. No Blender/SVG sprite construction before approval.
3. **Build the four Blender/SVG idles.** With the approved concept as the
   visual authority, author layered Grease Pencil geometry through Blender
   MCP, save the editable `.blend` and export real vector SVGs. Derive the
   existing 64×64 PNG game cells from those SVGs. Do not silently reuse the
   superseded idle-v2 construction or treat its parity evidence as new work.
4. **Perform internal likeness QA.** Compare the actual exported cells with
   the approved concept at equal figure height and inspect 1×/2× game-scale
   readability. Check facial features, hair, proportions, silhouette,
   clothing and equipment in all four directions. Iterate internally until
   they closely match. Technical SVG/PNG parity is a separate check and
   cannot establish likeness or artistic approval.
5. **Obtain explicit idle approval.** Present all four exact PNG idles and
   their SVG sources together, with the approved concept for comparison.
   Record James's decision separately from internal QA. Do not animate until
   he approves these idles. Material redesign reopens the relevant concept
   or idle gate.
6. **Animate and verify.** Build a proper rig, part ownership and hidden
   surfaces. Complete one walk direction with weight transfer, counter-swing,
   planted feet and scarf follow-through before extending the other views.
   Export all 24 poses, verify source/SVG/PNG/sheet/preview parity and obtain
   the separate art handoff approval.
7. **Perform game acceptance.** Integrate the approved art via the World lane
   and give James a short current-checkout browser test. Concept approval,
   idle approval and export checks do not establish live Phaser acceptance.

## Historical idle-v2 evidence

`review/user-decisions.json` records idle-v2 as superseded and unapproved.
`review/visual-qa.json` preserves the earlier internal assessment under that
status. The assessment compared the output with a historical turnaround that
we incorrectly called approved concept art; it does not pass the new concept
or likeness gate.

The old process sampled that turnaround, reconstructed contiguous colour
regions as Grease Pencil polygons with holes, and exported SVGs. Technical
proofs still show what that process did, but not that its reference was
approved or its art was accepted:

- `review/qa.json`: historical dimensions, alpha, palette and preview crops.
- `review/source-parity.json`: historical construction/SVG/readback/RGBA parity.
- `review/reload-parity.json`: historical reopening and re-export results.
- `review/visual-qa.json`: superseded likeness assessment and failed iterations.
- `reference/studies/`: historical sampling comparisons, not fresh concepts.
- `review/rejected-idle-v1/`: presented draft and rejection; its complete source
  remains at commit `110b26e`.

The scripts under `source/` and `reference/studies/` are retained for that
historical reproduction. Do not run them to advance the active concept stage.
The old rasterizer accepts only a pending idle decision; the superseded
idle-v2 decision intentionally prevents it from overwriting that review.
After concept approval, start a distinct sprite revision with the approved
concept's provenance before adapting these tools.

## Source and runtime contracts

The approved concept determines appearance. Blender's `.blend` is the
editable sprite/animation master; each SVG is an actual vector pose export;
PNG cells are derived runtime outputs. SVGs must contain real paths/fills,
not embedded raster images, external resources, filters or fonts. Preserve
semantic editing groups, source hashes, export settings and review hashes.

The runtime contract remains 64×64 cells, feet at `(32,56)`, a 24×24 gameplay
body, down/left/right/up rows, six columns (idle, contact-left, passing-left,
contact-right, passing-right, settle), 8 FPS walk and 12 FPS sprint. Retain
binary alpha, no baked shadow and nearest-neighbour integer scaling. There
is no new runtime SVG loader. Do not normalize every animation frame's visible
height; body bob and lifted feet must survive.

## Tooling evidence

Historical setup evidence records Blender 5.2.1 LTS and Blender MCP 1.9.1,
with native Codex tools, protocol 5, a matching add-on and telemetry disabled.
[Setup instructions](setup/README.md) and [setup evidence](setup/setup-report.json)
cover installation and the separate Grease Pencil export fixture. Those
proofs establish tooling only and do not waive concept approval. Verify the
live connection again when sprite production is authorized. The current
stage state is in [workflow.json](workflow.json).
