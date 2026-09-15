# Avatar 1 idle-v5 — rejected illustrated draft

**Status: rejected on 2026-09-15. The artistic pass and approval request are
withdrawn; no replacement candidate is ready.**

James rejected the design: “this is not the same design as what we originally
requested - I assume only concept art in which this makes no sense to show
in-game...” The [decision record](review/user-decisions.json) preserves that
quote, the original reviewed hashes and preparation timestamp. The
[corrected visual assessment](review/visual-qa.json) answers the quality
question with **no** and retains the complete previous assessment under
`priorAssessment` with its original inspection timestamp and evidence.

The draft was a detailed full-height illustration. Its style, viewpoint,
detail and proportions did not match the originally requested warm,
lower-resolution 16-bit JRPG game cutout. The
[originally approved medium Avatar 1 sprite reference](../reference/approved-concept-turnaround.png)
is the authority for sprite style, proportions and elevated game viewpoint.
The [original brief recovery note](../reference/original-style-recovery.md)
records the primary instructions and approval.
Its old filename does not make it fresh concept art. Avatar 1 uses medium
sprite proportions; only Avatars 6 and 14 were intentionally chibi.

The [approved concept-v2](../concept/avatar-1-concept-v2.png), SHA-256
`8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92`,
remains the character identity/costume authority. Concept approval did not
approve literal illustration proportions or treatment for the in-game sprite.
The [D-059 correction](../../../../../../docs/DECISIONS.md#d-059--avatar-1-authoring-uses-blender-mcp-and-real-svg-pose-files)
and [active workflow](../README.md) now require an internal **sprite design
translation** gate before renewed four-idle production, comparing against
both references. No new pixel-density parameters are selected here.

## Historical construction and evidence

V5 used 512×512 native Grease Pencil vectors through Blender MCP, real SVG
exports, and smooth 256×256 PNGs at density 4. Its isolated Phaser preview
rendered a 64×64 logical frame at camera zoom 2, with feet at (32,56), origin
(0.5,0.875), and a 24×24 world-unit body. These are the rejected revision's
historical parameters; they are not a newly selected replacement contract.

The native Blender source, SVG/PNG files, engine captures and original
technical reports are preserved. No visual artifacts or historical capture
timestamps are changed by the rejection correction. Those checks demonstrated
the authoring/export path and actual engine rendering. They could not establish
that the sprite design matched the original brief. The former positive
producer judgment has therefore been withdrawn.

No idle approval, animation authorization or production integration approval
exists for this revision. Its preview and captures are historical evidence,
not an active approval handoff. The accepted production asset remains current.

## Historical pre-handoff evidence guard

The former handoff check is retained for reproducibility. It must now reject
`review/visual-qa.json`, whose answer is no after the user rejection. Do not
rewrite the rejection, prior assessment or historical reports to restore a
pass. Run the read-only check from this revision directory:

```sh
python3 source/verify_review.py
```

This is a procedural guard against missing or stale review evidence. It cannot
judge beauty, establish that someone actually looked at an image, or grant
user approval. It never rewrites the review or changes any status. For this rejected revision, failure is the expected result. A future draft
must follow the current workflow and pass its internal sprite design
translation and direct visual inspection gates.

The former positive-review schema is documented below as historical tooling. Every `sha256` and map value is the
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

For a positive candidate, the guard also binds the inspection board to `review/raster-qa.json` and all
current SVG/PNG inputs, and checks every inventoried input in
`review/source-parity.json`. The historical source report binds the former user-decision bytes; it is
not regenerated after this rejection. Updating a later candidate would
require fresh source verification and new evidence bindings. Keep `userApproval` and the separate `userDecision` unset for this
pre-handoff check; animation and production integration remain unauthorized.
Do not record an affirmative visual answer until the producer has actually
made that judgment by looking at the resulting engine captures.

## Current result

Four native Blender/SVG idles have been exported and reopened-source parity verified. The producer personally viewed the native source, exports, matched-height concept comparison, and actual WebGL Phaser captures on road, pavement and grass at zoom 2. See [visual judgment](review/visual-qa.json) and [engine preview](preview/README.md). The separate subtle contact shadow is part of the preview rendering recipe and is not baked into the art.
