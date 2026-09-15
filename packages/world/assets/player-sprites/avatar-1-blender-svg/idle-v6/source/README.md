# Avatar 1 v6 native pixel-sprite source

This revision translates the approved character identity into the original
medium JRPG sprite style. Technical source parity cannot establish that this
translation looks right. The producer must compare both references, inspect
every exported view and inspect actual Phaser rendering before any handoff.

## Input contract

`idle-geometry.json` declares `cell: [64,64]`, `feetPivot: [32,56]`,
`conceptSha256`, `styleSha256`, an explicit `constructionReferences` list and
`provenance.constructionReferences` with matching `{file, sha256}` entries.
Optional `provenance.inputFiles` entries bind other construction inputs by
current revision-relative path and SHA-256. Nothing is discovered implicitly.

`views` is a nonempty subset of `down`, `left`, `right`, `up`. A front-only
internal study can therefore become the four-idle set without another format.
Every view is an ordered list of `{part, color, contours}` filled regions.
Each contour contains integer `[x,y]` pixel-edge vertices within the 64×64
canvas. Edges must be nonzero and orthogonal, and contours must enclose area.
Each shape's contours share one even-odd fill, allowing holes. Pixel clusters
remain editable polygon regions in native Grease Pencil; no SVG bitmap embeds
or antialias threshold cleanup is allowed.

`palette.json` contains `colors: [{name, hex}]` and may state
`maximumColorsGlobal: 32`. All views share at most 32 distinct opaque RGB
colors. Channel values are limited to 254: Blender's native SVG conversion
truncates integer channels, so linear materials use a quarter-unit sRGB bias
to preserve the authored values exactly. Transparency is separate from the
opaque palette. Final PNGs are exactly 64×64 at density 1 with binary alpha;
nearest-neighbor display preserves these authored pixels.

Both immutable references are packed outside the camera and hash-bound in
the geometry, saved scene, export environment and readback:

- `../../concept/avatar-1-concept-v2.png`: approved identity/costume,
  SHA-256 `8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92`.
- `../../reference/approved-concept-turnaround.png`: original approved medium
  JRPG sprite style/proportions, SHA-256
  `f1de96b3038042aaca726c18ae87fe374e8dac2bbda7d0a2359d53f44ad08ed4`.

Listed construction studies must exist under `../studies/`; their packed
bytes and hashes are also checked. Studies have no approval authority.

## Native Blender sequence

The coordinator owns Blender MCP calls. Set `AVATAR_SOURCE_DIR` to this
absolute directory and execute scripts in this order:

1. `authoring.py` validates inputs and builds the owned `AV1V6 | ` scene,
   materials and ordered polygon fills. Only an `internal-refinement`
   `../review/user-decisions.json` allows authoring or export. Frozen
   candidates must be explicitly returned to internal refinement before any
   rebuild. Shared objects in another scene are preserved and block rebuild.
2. `export_svg.py` uses Blender's native SVG operator for the currently
   declared views and saves `avatar-1.blend`, then records current artifact
   hashes in `blender-environment.json`. Other revisions are not modified.
3. Reopen that exact saved `avatar-1.blend` through Blender MCP. Reopening is
   a coordinator action, not a claim the verification script can establish.
4. Run `readback.py` in the reopened, unmodified master. It reads live
   geometry, material fills, packed reference bytes and source metadata into
   `blender-readback.json`. It does not reconstruct or save the artwork.
5. Run `verify_source.py` externally using Python with Pillow. It verifies
   current input and master hashes, native ordered geometry/material parity,
   exact exported SVG fills and pixel-edge coordinates, and both references.
   Present PNGs additionally require binary alpha, the global authored
   palette and all 4096 pixel centers matching the ordered source polygons.
   PNGs may be absent during a native construction experiment.

Example Python runtime:

```sh
/Users/james.wilcock/.cache/strkworld-avatar-vector/venv/bin/python source/verify_source.py
```

The camera uses a 64-unit orthographic view at distance 1024. Both camera and
viewport clipping extend to 4096; otherwise the native viewport can appear
blank while SVG export succeeds. The saved initial direction is `down` when
available. This source contains idle frames only. Region layers are editable
artwork, not an animation rig.

`../review/source-parity.json` is technical evidence only. Verification may
read a frozen candidate, but cannot grant artistic quality, user sprite
approval, animation authorization, game acceptance or runtime integration.
