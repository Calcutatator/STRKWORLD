# Avatar 1 — concept approval, Blender MCP and SVG workflow

**Active stage: rebuilt idle-v4 is frozen for James’s separate idle approval.**
Idle-v3 is withdrawn and unapproved. Its earlier visual pass was too
permissive: renewed inspection found a rigid pose, lifeless face, muddy
shading, flat cutout profiles and lost character identity at game size.
James approved the exact concept with “Yes good concept move forward”. This
authorizes four Blender/SVG idle facings and internal likeness QA. Final sprite
cells, animation and game integration are not approved by the concept decision.
`idle-v2` remains superseded and unapproved because it skipped the concept gate.
See [D-059](../../../../../docs/DECISIONS.md#d-059--avatar-1-authoring-uses-blender-mcp-and-real-svg-pose-files).

## Current review and authority

The [approved fresh concept-v2](concept/avatar-1-concept-v2.png) is the visual
authority for this restart. [Its approval record](concept/approval.json) binds
James's explicit decision to SHA-256
`8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92`.
Internal review corrected scarf and buckle continuity before that approval.

The rebuilt revision is **idle-v4**. The producing agent inspected its actual
SVG-derived cells at 1×/2× against the concept, rejected the initial facial
rendering, and refined the heads before passing it for user review. The
[exact idles](idle-v4/review/idle-approval.png), [concept comparison](idle-v4/review/reference-comparison.png)
and [editable Blender/SVG sources](idle-v4/README.md) are ready.
New concept-derived construction studies guide explicit colour-region vectors;
[provenance and QA](idle-v4/review/visual-qa.json) distinguish those studies from
the approved concept and final native Blender exports.
The [idle-v3 review](idle-v3/review/idle-approval.png),
[concept comparison](idle-v3/review/reference-comparison.png) and
[editable sources](idle-v3/README.md) remain historical evidence.
Its [withdrawn visual assessment](idle-v3/review/visual-qa.json) preserves the
prior assessment and the correction. Saved-master export parity remains
technical evidence only. James has granted no idle approval.

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

1. **Fresh concept creation — complete.** Concept-v2 is a new illustrated
   character design, not a sprite sheet or conversion of the prior turnaround.
2. **Explicit concept approval — complete.** James approved exact concept-v2
   with “Yes good concept move forward”; `concept/approval.json` records the
   reviewed hash. A later concept redesign requires renewed concept approval.
3. **Build and refine the four Blender/SVG idles — complete for review.** In `idle-v4/`, with
   approved concept-v2 as the
   visual authority, author layered Grease Pencil geometry through Blender
   MCP, save the editable `.blend` and export real vector SVGs. Derive the
   existing 64×64 PNG game cells from those SVGs. Do not silently reuse the
   superseded idle-v2 construction or treat its parity evidence as new work.
4. **Perform internal aesthetic and likeness QA — passed for idle-v4 review.** Judge whether
   the actual exported sprite looks good before any handoff. Compare it with
   the approved concept at equal figure height and inspect exact 1×/2× cells.
   Require a natural pose, readable expression, clear shading, convincing
   directional form and the approved character's identity. Costume inventory
   and export validity are insufficient. If the result looks rough, rigid,
   muddy, lifeless or like a flat cutout, continue internal refinement.
   Technical SVG/PNG parity cannot establish visual quality or approval.
5. **Obtain explicit idle approval.** Present all four exact PNG idles and
   their SVG sources together, with the approved concept for comparison,
   only after the producing agent has passed the aesthetic review above.
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

The scripts under root `source/` and `reference/studies/` are retained for
historical reproduction. Do not overwrite or reuse the old construction as
new artwork. The old rasterizer accepts only a pending idle decision; the
superseded idle-v2 decision intentionally prevents it from overwriting that
review. Any adapted tooling belongs in the distinct active revision and
must record approved concept-v2 as its visual authority.

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
proofs establish tooling only. Verify the live connection for the authorized
idle production; this workflow update does not claim a new handshake or
export result. The current stage state is in [workflow.json](workflow.json).
