# STRKWORLD player sprites v1

This directory is an isolated D-052 art-correction candidate for the eight
paired player-character designs. It is awaiting independent orchestration
review and is not runtime-ready or rendered acceptance. The older `v1-review/`
directory remains unchanged as the historical review and generation-provenance
record.

## Files

- `avatar-1.png` through `avatar-8.png` are the cosy/default states.
- `avatar-9.png` through `avatar-16.png` are the paired fighting states.
- `source/player-sprites.aseprite` is the editable 320-frame source.
- `manifest.json` is the runtime-neutral asset contract and pair mapping.
- `qa/` contains mechanical reports, four-background evidence, enlarged
  movement contacts, per-key and paired animated previews, explicit pixel
  repair evidence, and the cross-facing identity gate.

## Sheet contract

Every PNG is a transparent 320x256 sheet containing 5 columns by 4 rows of
64x64 cells.

| Axis | Order |
| --- | --- |
| Columns | `idle`, `contact-left`, `passing-left`, `contact-right`, `passing-right` |
| Rows | `down`, `left`, `right`, `up` |

The fixed feet point is `(32,56)` in every cell. The corresponding normalized
origin is `(0.5,0.875)`. The common 24x24 gameplay/contact body remains owned
by runtime and must not be resized from the visual silhouette.

Use nearest-neighbour sampling and integer scaling. Do not enable
anti-aliasing. Play a normal walk as columns `0,1,2,3,4` at 8 FPS and sprint
at 12 FPS. Sprint movement speed remains code-owned.

No frame contains a baked shadow. If World adds a shadow, it should render one
consistent runtime-owned shadow behind every local, remote, and Studio avatar.

## Character checks

The four-facing identities and movement cells were reconstructed per character
from approved model references; they are not mirrored or blanket zone copies.
The fighting weapons remain direction-specific and hand-connected. Down/up
movement uses connected upper-silhouette, waist, hip and planted-foot changes
so it reads as depth transfer rather than horizontal rocking. The approved
size classes remain fixed: only 6/14 are small/chibi, only 4/7/12/15 are large,
and all other keys use the standard class. `qa/explicit-pixel-repairs.json`
records the prior 799 named repairs plus the 64 D/U stride reconstructions and
six detached-component cell repairs.

Every cell also passes an 8-connected detached-opaque-component gate recorded
in `qa/detached-components.json`. This rejects floating feet, weapon fragments,
and other disconnected opaque islands; the whitelist is intentionally empty.

No runtime row or frame mapping was changed. The correction is not runtime-ready
until orchestration independently reviews the complete handoff.

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

The Aseprite file contains one `art` layer and 320 frames at 125 ms per frame.
Frames are grouped in key order, with 20 frames per key. It contains one
`avatar-N` tag for each of the 16 opaque keys.

The `logical-cell-64x64` slice records the 64x64 bounds and `(32,56)` pivot.
The `feet-pivot-32-56` slice records the fixed feet point. The common 24x24
gameplay/contact body remains runtime-authoritative and is not encoded as a
sprite slice or wire field.

## Provenance

The character concepts and pixels are project-owned STRKWORLD work produced
under James Wilcock's art direction. This D-052 pass applies character-specific
pixel reconstruction guided by project-owned reference turnarounds,
nearest-neighbour quantization, explicit anatomy-gap repair, and
source-preserving sheet assembly. Generated imagery was used as visual
guidance only; the final sheets contain controlled project-owned pixels. No
third-party source pixels or external asset packs are incorporated. The work
is intentionally Chrono Trigger-adjacent in era and readability, but does not
copy its characters, silhouettes, clothing, palettes, frames, or pixels.

Verified 2026-08-20. Project use and modification are controlled by the
STRKWORLD project owner.
