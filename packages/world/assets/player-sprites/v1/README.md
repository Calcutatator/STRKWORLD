# STRKWORLD player sprites v1

This directory is the final art handoff for the eight paired player-character
designs. It is not yet integrated into World and has not passed rendered
in-game acceptance. The older `v1-review/` directory remains the review and
generation-provenance record.

## Files

- `avatar-1.png` through `avatar-8.png` are the cosy/default states.
- `avatar-9.png` through `avatar-16.png` are the paired fighting states.
- `source/player-sprites.aseprite` is the editable 192-frame source.
- `manifest.json` is the runtime-neutral asset contract and pair mapping.
- `qa/` contains mechanical reports, four-background evidence, a complete
  movement contact, and one animated preview per paired character.

## Sheet contract

Every PNG is a transparent 192x256 sheet containing 3 columns by 4 rows of
64x64 cells.

| Axis | Order |
| --- | --- |
| Columns | `idle`, `walk-1`, `walk-2` |
| Rows | `down`, `left`, `right`, `up` |

The fixed feet point is `(32,56)` in every cell. The corresponding normalized
origin is `(0.5,0.875)`. The common 24x24 gameplay/contact body remains owned
by runtime and must not be resized from the visual silhouette.

Use nearest-neighbour sampling and integer scaling. Do not enable
anti-aliasing. Play a normal walk as columns `0,1,0,2` at 8 FPS and sprint at
12 FPS. Sprint movement speed remains code-owned.

No frame contains a baked shadow. If World adds a shadow, it should render one
consistent runtime-owned shadow behind every local, remote, and Studio avatar.

## Character checks

- Characters 4 and 7 remain the two deliberately large silhouettes in both
  states and all facings.
- Character 6 remains the deliberately small, chibi female mechanic.
- Character 5 is female in both paired states.
- Character 7's fighting state includes the approved helmet.
- Fighting states carry one visible weapon set; no frame includes a duplicate
  weapon on the back.
- Cosy and fighting states preserve each character's hair and clothing palette.

Creative names and personalities are intentionally absent from the runtime
manifest. The game and lobby see only the opaque `avatar-1..avatar-16` keys.
Appearance has no wallet, account, protocol, route, privacy, or financial
meaning.

## Editable source

The Aseprite file contains one `art` layer and 192 frames at 125 ms per frame.
Frames are grouped in key order, with 12 frames per key. It contains 80 tags:
one `avatar-N` tag and four `avatar-N/{direction}` tags for each key.

The `logical-canvas` slice records the 64x64 bounds and `(32,56)` pivot. The
`runtime-body-reference` slice records the common 24x24 body for reference
only; runtime remains authoritative for collision and Studio contact geometry.

## Provenance

The character concepts and pixels are original STRKWORLD work produced under
James Wilcock's art direction through an OpenAI Codex/ImageGen workflow, then
cleaned, normalized, and assembled into the editable Aseprite source. No
third-party source pixels or external asset packs are incorporated. The work
is intentionally Chrono Trigger-adjacent in era and readability, but does not
copy its characters, silhouettes, clothing, palettes, frames, or pixels.

Verified 2026-08-20. Project use and modification are controlled by the
STRKWORLD project owner.
