# Detailed native Blender vector pipeline

This revision preserves detailed construction artwork as vector regions on a
512 × 512 source canvas. The texture export is 256 × 256 with smooth alpha
coverage and no output palette clamp. Its logical game cell remains 64 × 64:
source feet `[256,448]`, texture feet `[128,224]`, logical feet `[32,56]`.
The runtime review path must apply density 4 without changing physical size.

The input `idle-geometry.json` contains:

```json
{
  "conceptSha256": "exact approved concept hash",
  "cell": [512, 512],
  "feetPivot": [256, 448],
  "logicalCell": [64, 64],
  "constructionReferences": ["studies/front-construction.png"],
  "provenance": {
    "constructionReferences": [{"file": "studies/front-construction.png", "sha256": "current hash"}],
    "inputFiles": [{"file": "studies/front-vector.svg", "sha256": "current hash"}]
  },
  "views": {
    "down": [{"part": "region-001", "color": "teal", "contours": [[[240,100],[250,100],[250,110]]]}]
  }
}
```

`views` accepts any nonempty subset of down/left/right/up during internal
construction. `contours` are ordered polygon loops; holes stay in the same
region and use the native export's even-odd fill semantics. `palette.json`
holds `colors:[{name,hex}]`, at most 256 distinct named flat fills. This limit
applies only to authored fills; antialias colors in PNGs are preserved.
Every declared construction reference must be a bitmap beneath `studies/`
and have an exact hash in provenance. `inputFiles` is optional additional
binding evidence, suitable for intermediate high-detail vector artwork.
`source/vectorize_studies.py` is inventoried as the upstream constructor.

The approved concept remains separately packed and hash-bound. Construction
studies are packed outside the camera and explicitly labelled as internal
studies rather than approved concept art. Image assistance and tracing must
be described honestly in provenance. A 64 × 64 artist grid is not an input
for this revision.

Authoring, export, and rasterization require
`review/user-decisions.json.status == "internal-refinement"`. Frozen reviews
are protected against accidental mutation; technical verification may read
them. Only the `AV1V5 | ` scene and its owned, unshared objects are rebuilt.
An object shared into another scene causes a stop before deleting that object.

The coordinator serially runs these scripts through native Blender MCP:

```python
from pathlib import Path
AVATAR_SOURCE_DIR = '/absolute/path/to/idle-v5/source'
script = Path(AVATAR_SOURCE_DIR) / 'authoring.py'
exec(compile(script.read_text(), str(script), 'exec'))
```

Repeat with `export_svg.py`. It exports the live Grease Pencil artwork to
512 × 512 native SVG paths and saves `avatar-1.blend`. It does not rebuild
geometry or normalize individual poses. Reopen that exact master before
running `readback.py`:

```python
import bpy
bpy.ops.wm.open_mainfile(filepath=AVATAR_SOURCE_DIR + '/avatar-1.blend')
```

Then run locally:

```sh
node /absolute/path/to/idle-v5/source/rasterize.cjs
python3 /absolute/path/to/idle-v5/source/verify_source.py
```

Rasterization checks the current concept/input/master/export bindings,
validates a self-contained vector SVG, renders at 512², and downsamples to
256² with Lanczos3. It preserves sRGB color and fractional alpha, writing
`review/raster-qa.json` plus `review/idle-inspection.png`. The latter shows
the exported texture at 256, 128 and 64 pixels, and is labelled as an
internal static export inspection. It is not evidence of live rendering.

The source verifier compares current ordered regions, compound contours,
actual live Grease Pencil materials/fill flags, object transforms, packed
reference bytes, native SVG paths and exact fill colors. It binds all
reports to current master/input hashes. The coordinator performs the real
Blender reopen and owns visual inspection. Neither checker judges beauty,
concept likeness, pose appeal, game readability, or readiness for handoff.
