# Avatar 1 — native JRPG idle draft v6

Status: **ready for exact four-idle approval; not approved for animation**.

Open http://127.0.0.1:5173/ and use All four / Game size, then Road, Pavement
and Grass. The main canvas is actual Phaser using the existing town assets.
The two side references explain sprite style and character identity.

- [Actual game capture](review/phaser-road-viewport.png)
- [Exact SVG-derived output inspection](review/idle-inspection.png)
- [Producer visual QA](review/visual-qa.json)
- [Independent engine QA](review/independent-visual-qa.json)
- [Native source and pixel parity](review/source-parity.json)
- [User decision — pending](review/user-decisions.json)
- [Blender master](source/avatar-1.blend)

`svg/{down,left,right,up}/idle.svg` contains native filled paths, without
embedded raster images. `frames/{direction}/idle.png` is the exact 64×64
rendered result. Feet pivot is32,56; the physics body remains24×24 world units.
The shared palette has32 authored colors and27 occur in the final outputs.

Construction order: internal ImageGen studies → explicit grid registration
with a shared material palette → recorded face/scarf pixel edits → contiguous
vector regions → Blender MCP Grease Pencil master → native SVG → native64 PNG.
The studies are source material, not user-approved idles. The visible source
partitions are not an animation rig or a complete hidden-anatomy model.

The original medium JRPG reference governs style, proportions and elevated
viewpoint; concept-v2 governs identity and costume. Both are packed in the
master and hash-bound to the source. See [source tools](source/README.md).

Before handing off this frozen revision, run `source/verify_review.py` with
Python. `source/verify_source.py` performs source parity and PNG pixel checks.
Authoring scripts reject writes while this revision is pending. Material
changes reopen internal refinement and require new source and engine inspection.
Animation and production integration remain separate later gates.
