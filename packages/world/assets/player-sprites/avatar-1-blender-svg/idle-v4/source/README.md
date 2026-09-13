# Native Blender construction tools

These tools build an internal, editable Grease Pencil source, export native
SVG paths and check technical parity. A successful export or verification does
not assess whether the sprite looks good or is ready for user review.

Inputs:

- `idle-geometry.json`: `conceptSha256`, `views`, and optional `provenance` and
  `constructionReferences`. Views are any nonempty subset of `down`, `left`,
  `right`, `up`. Each view is an ordered array of
  `{part, color, contours: [[[x, y], ...], ...]}` filled regions. Holes belong
  to the same region and use even-odd SVG fill semantics. Coordinates are in
  the final 64 × 64 cell.
- `palette.json`: `colors: [{name, hex}]`, with an optional
  `maximumColorsPerFrame` no greater than 24. Geometry `color` values refer to
  these names.
- `../review/user-decisions.json`: status must be `internal-refinement` for authoring/export. Read-only
  verification also supports frozen `pending` or decided review records.
- `../../concept/approval.json`: the exact current concept must be approved,
  and its SHA-256 must match both the image bytes and geometry binding.

Set `constructionReferences` explicitly to paths relative to `idle-v4`, for
example `studies/front-construction-v1.png`. Omission discovers files named
`studies/*construction*.png`. Every construction reference is packed outside
the camera and labelled as an internal ImageGen study, not approved concept
art. The approved concept is separately packed and hash-bound. Record any
image assistance, sampling and manual corrections honestly in `provenance`;
the tooling cannot infer how the supplied contours were created.

The coordinator runs the following in order through native Blender MCP,
using the current user instruction as `user_prompt`:

```python
from pathlib import Path
AVATAR_SOURCE_DIR = '/absolute/path/to/idle-v4/source'
script = Path(AVATAR_SOURCE_DIR) / 'authoring.py'
exec(compile(script.read_text(), str(script), 'exec'))
```

Run the same invocation with `export_svg.py`. This exports only declared
views, leaves the front view selected if present, and saves `avatar-1.blend`.
Then reopen the actual saved master before obtaining the readback:

```python
import bpy
bpy.ops.wm.open_mainfile(filepath=AVATAR_SOURCE_DIR + '/avatar-1.blend')
```

Supply `AVATAR_SOURCE_DIR` again in the next MCP call and execute
`readback.py`. Finally run locally:

```sh
python3 /absolute/path/to/idle-v4/source/verify_source.py
```

The verifier checks ordered source regions, all contours, actual live
material colors and fill state, identity transforms, packed reference bytes,
native SVG coordinates and exact palette fills, and current saved-master
hashes. It writes `../review/source-parity.json`. PNGs are optional inventory;
their pixels are not checked by this verifier. The coordinator owns the
actual reopen step, raster parity and visual inspection.

Only `AV1V4 | ` objects and their unshared scene are rebuilt. Other scenes
remain intact. The exporter never rebuilds geometry or rescales individual
poses. Existing v4 objects shared into another scene are an ownership conflict
that must be resolved before rebuilding.
