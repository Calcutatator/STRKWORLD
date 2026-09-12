# Avatar 1 fresh idle draft — 2026-09-12

**Status: REJECTED by James on 2026-09-12 for the in-game appearance.** This
raster draft is retained only as historical evidence. It must not be used as
the reference for animation or integrated. The replacement is the
[Blender MCP/SVG workflow](../avatar-1-blender-svg/README.md). The existing
approved `v1/avatar-1.png` remains unchanged.

The [historical review image](review/approval.png) shows the same exact cells
at 4× on dark grey and 2× on a light background. The
[native strip](avatar-1-idle-turnaround.png) is 256×64, ordered down, left,
right, up. Individual transparent 64×64 PNGs are in `cells/`.

The image's pending-approval caption records its state when first presented;
the [subsequent user decision](review/user-decision.json) rejects this set.
No movement frames were authored.

## Creation and export

The built-in ImageGen tool produced a new four-view image from
[`source/prompt.txt`](source/prompt.txt). The old approved references were
inspected to recover identity; their pixels were not reused. The tool returned
a 1254×1254 RGBA image despite the prompt's 1024×1024 request, and did not
deliver an exact 64×64 logical grid. The original output is preserved as
[`source/generated-turnaround.png`](source/generated-turnaround.png).
No claim is made about the image tool's underlying model or about a measured
quality improvement from changing the orchestration model.

[`source/export.cjs`](source/export.cjs) converts the preserved image to exact
idle cells: four source quadrants, alpha bounds, nearest-neighbour reduction
to 50 visible pixels, sole-centre registration at approximately x=32 and
bottom at y=56, binary alpha threshold 128, and one shared 24-colour palette.
The palette reserves a dark facial/outline colour and a light facial colour.
This conversion changes pixels; the exact exported cells, not the large
generated reference, are what this approval covers. No shape drawing,
contour repair, hole filling or individual eye edits were performed.

The generated reference and export script are the editable working sources
for this draft. A final layered/tagged animation source is still to be made.
Do not apply per-frame height normalization to future animation poses: doing
so can erase intended body motion.

The old exporter used Node.js with Sharp 0.35.4. It now refuses to run when
the user-decision record marks the draft rejected, so a regeneration cannot
silently restore a pending-approval state. The original converter and review
remain available in commit `8c45d0e` for historical reproduction.

The actual run used the bundled Codex Node and Sharp runtime; no project
dependency or authoring application was installed. The script recreates the
cells, native strip, approval image and machine-readable QA from the saved
source. The text-to-image generation itself is not deterministic.

## Verified cutoff

[`review/qa.json`](review/qa.json) records four 64×64 cells, binary alpha, a
shared 24-colour opaque palette, 50-pixel visible height, a common feet line,
safe bounds, one 8-connected opaque component per cell and PNG/raw-RGBA
hashes. Separate verification confirms that the strip's four crops reproduce
the individual cells exactly. Mechanical checks do not approve anatomy,
accessory consistency or animation.

User approval was rejected despite the mechanical checks passing. Animation,
full animation QA, layered animation source round-trip and live Phaser/browser
acceptance have not been performed.

See [the flow review](../../../../../docs/research/avatar-1-restart-2026-09-12.md)
for the recovered approval sequence and historical investigation. Follow the
linked Blender MCP/SVG workflow for new authoring.
