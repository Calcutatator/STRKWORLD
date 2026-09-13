# Avatar 1 idle-v5 — illustrated vector refinement

**Status: producer-inspected idle draft; pending explicit user approval.**

This revision applies the user-approved higher-detail illustrated-vector
route in [D-059](../../../../../../docs/DECISIONS.md#d-059--avatar-1-authoring-uses-blender-mcp-and-real-svg-pose-files).
The [approved concept-v2](../concept/avatar-1-concept-v2.png) remains the
visual authority, bound to SHA-256
`8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92`.

Author detailed editable native Grease Pencil forms through Blender MCP on a
512×512 vector canvas, export real SVGs, and derive 256×256 PNGs at density 4.
Render a 64×64 logical frame with feet at (32,56), origin (0.5,0.875), and a
verified 24×24 world-unit body. Smooth alpha, an appropriate unrestricted
palette and linear avatar texture filtering are allowed by the amendment.

The necessary isolated actual-Phaser preview uses the real town assets and
camera zoom 2. It is authorized to demonstrate this draft at real game CSS
scale. Production asset replacement, shared-runtime changes and financial
flows are outside this draft.

Before every handoff, the producing agent must personally inspect the source,
exact exports and actual Phaser rendering for all four turns on light and
dark town surfaces, comparing the figure with the approved concept. Record
actual engine screenshots, viewport/CSS scale, device pixel ratio, zoom,
density, filtering, exact source/export hashes and the producer's observed
quality judgment. Independent review and technical parity support this work;
they do not replace direct inspection.

Ask: **“Is this in-game result obviously good enough to approve?”** If no,
if it has not been viewed, or if known visible defects qualify the answer,
continue refinement. Any material artwork/rendering change requires another
inspection. Do not freeze or send an approval candidate until this gate passes.

[User decisions](review/user-decisions.json) remain separate from internal
QA. No idle approval, animation authorization or production integration
approval exists for this revision. Follow the [active workflow](../README.md).

## Before-handoff evidence guard

After personally inspecting the final source and actual engine result, record
that judgment in `review/visual-qa.json`. Run the read-only check from this
revision directory:

```sh
python3 source/verify_review.py
```

This is a procedural guard against missing or stale review evidence. It cannot
judge beauty, establish that someone actually looked at an image, or grant
user approval. It never rewrites the review or changes any status. A failure
keeps the draft in refinement; re-export, re-capture and personally inspect
changed artwork before recording a new affirmative judgment.

The review record uses this schema. Every `sha256` and map value is the
lowercase SHA-256 of the exact existing file; paths are relative to idle-v5.
Placeholder hashes below are intentionally invalid and cannot pass.

```json
{
  "schemaVersion": 1,
  "revision": "idle-v5",
  "producerPersonallyInspected": true,
  "question": "Is this in-game result obviously good enough to approve?",
  "answer": "yes",
  "knownBlockingDefects": [],
  "userApproval": null,
  "sourceEvidence": {
    "file": "review/idle-inspection.png",
    "sha256": "<current-file-hash>"
  },
  "sourceParity": {
    "file": "review/source-parity.json",
    "sha256": "<current-file-hash>"
  },
  "reviewedArtifacts": {
    "frames/down/idle.png": "<current-file-hash>",
    "frames/left/idle.png": "<current-file-hash>",
    "frames/right/idle.png": "<current-file-hash>",
    "frames/up/idle.png": "<current-file-hash>",
    "svg/down/idle.svg": "<current-file-hash>",
    "svg/left/idle.svg": "<current-file-hash>",
    "svg/right/idle.svg": "<current-file-hash>",
    "svg/up/idle.svg": "<current-file-hash>",
    "source/avatar-1.blend": "<current-file-hash>",
    "source/idle-geometry.json": "<current-file-hash>",
    "source/palette.json": "<current-file-hash>"
  },
  "engineEvidence": [
    {
      "surface": "road",
      "viewport": {
        "file": "review/engine/phaser-road-viewport.png",
        "sha256": "<current-file-hash>"
      },
      "canvas": {
        "file": "review/engine/phaser-road-canvas.png",
        "sha256": "<current-file-hash>"
      },
      "metadata": {
        "file": "review/engine/phaser-road-evidence.raw.json",
        "sha256": "<current-file-hash>"
      }
    }
  ]
}
```

The `engineEvidence` list must contain exactly one complete entry each for
`road`, `pavement` and `grass`, following the filename pattern shown. It accepts
the preserved browser-tool `.raw.json` envelope or direct `-evidence.json`
metadata. Each capture must show the four-facing lineup, WebGL, zoom 2,
64×64 logical and 128×128 CSS cells, density 4, a 24×24 world body, linear
avatar filtering and no engine errors. Viewport/canvas dimensions and device
pixel ratio must match the screenshot dimensions. Recorded frame, preview-code
and town-source hashes must match current files.

The guard also binds the inspection board to `review/raster-qa.json` and all
current SVG/PNG inputs, and checks every inventoried input in
`review/source-parity.json`. Re-run `source/verify_source.py` after changes to
its inputs, including `review/user-decisions.json`, then bind the new report
hash. Keep `userApproval` and the separate `userDecision` unset for this
pre-handoff check; animation and production integration remain unauthorized.
Do not record an affirmative visual answer until the producer has actually
made that judgment by looking at the resulting engine captures.

## Current result

Four native Blender/SVG idles have been exported and reopened-source parity verified. The producer personally viewed the native source, exports, matched-height concept comparison, and actual WebGL Phaser captures on road, pavement and grass at zoom 2. See [visual judgment](review/visual-qa.json) and [engine preview](preview/README.md). The separate subtle contact shadow is part of the preview rendering recipe and is not baked into the art.
