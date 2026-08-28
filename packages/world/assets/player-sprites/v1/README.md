# STRKWORLD player sprites v1

This directory contains the World-owned runtime sheets for the eight paired
player-character designs. Avatar 1 cosy has an explicitly approved production
override described below. That approval does not extend to Avatar 1 fighting
or avatars 2-16, whose existing files remain unchanged. James accepted the new
Avatar 1 cosy sheet in the live game on 2026-08-28; rendered acceptance of
Avatar 1 fighting and avatars 2-16 remains pending. The older `v1-review/`
directory remains unchanged as historical review and generation provenance.

## Files

- `avatar-1.png` through `avatar-8.png` are the cosy/default states.
- `avatar-9.png` through `avatar-16.png` are the paired fighting states.
- `source/player-sprites.aseprite` is the historical five-column, 320-frame
  source for the prior complete set. It does not encode the approved
  six-column Avatar 1 cosy override.
- `manifest.json` is the runtime-neutral asset contract and pair mapping.
- `qa/` contains mechanical reports, four-background evidence, enlarged
  movement contacts, per-key and paired animated previews, explicit pixel
  repair evidence, and the cross-facing identity gate.

## Sheet contract

Avatar 2 through Avatar 16 remain transparent 320x256 sheets containing 5
columns by 4 rows of 64x64 cells. Avatar 1 cosy is a transparent 384x256 sheet
containing 6 columns by 4 rows of 64x64 cells.

| Axis | Order |
| --- | --- |
| Default columns (Avatar 2-16) | `idle`, `contact-left`, `passing-left`, `contact-right`, `passing-right` |
| Avatar 1 cosy columns | `idle`, `contact-left`, `passing-left`, `contact-right`, `passing-right`, `settle` |
| Rows | `down`, `left`, `right`, `up` |

The fixed feet point is `(32,56)` in every cell. The corresponding normalized
origin is `(0.5,0.875)`. The common 24x24 gameplay/contact body remains owned
by runtime and must not be resized from the visual silhouette.

Use nearest-neighbour sampling and integer scaling. Do not enable
anti-aliasing. Play Avatar 1 cosy's normal walk as columns `0,1,2,3,4,5` at 8
FPS; the other sheets retain columns `0,1,2,3,4`. Sprint playback remains 12
FPS and sprint movement speed remains code-owned.

### Approved Avatar 1 cosy override

`avatar-1.png` is the exact approved 384x256 production candidate with SHA-256
`f0ea738353723abc18070210bf169002ede62003b03508b1e326ff9ae72e87bb`.
It preserves the approved down-eye correction. The attempted left/right
eye-lock pass was rejected and fully reverted; the side rows in this PNG are
pixel-identical to their pre-eye-pass versions, and the up row is unchanged.
The rejected artifact and its ledger are not part of this repository.

The scoped approval evidence is under `qa/avatar-1-cosy-six-column/`: 24/24
cells pass, all cells use binary alpha, the sheet crops reproduce all 24 cells,
the repo-owned raw-RGBA parity record correlates every named 64x64 crop to the
committed sheet, and the eye-anchor report records the exact side-row
reversion. The runtime uses the common `(32,56)` feet point, 24x24 body and no
baked shadow. This approval is Avatar 1 cosy only.

The prior 24-colour-per-frame cap remains the default for Avatar 2-16. The
exact approved Avatar 1 cosy sheet has a scoped maximum of 29 colours per
frame: 21 of its 24 cells use 25-29 colours and three use 24. This is an
explicit per-key exception, not permission to remap the approved pixels or to
relax the cap for any fighting sheet or Avatar 2-16 asset.

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
records 642 enclosed-hole fills across the initial and cross-gate passes, 1,088
transient channel repairs, 25 per-cell palette remaps, 662 seam-material
repairs, four isolated-pixel removals, 64 D/U stride reconstructions, two
D/U depth repairs, six weapon-boundary repairs, and six detached-component
cell repairs. These 2,499 ledger entries are explicit cell/coordinate
operations, not a blanket transform or global filter.

Every cell also passes an 8-connected detached-opaque-component gate recorded
in `qa/detached-components.json`. This rejects floating feet, weapon fragments,
and other disconnected opaque islands; the whitelist is intentionally empty.
`qa/verify-silhouette-holes.py` flood-fills exterior transparency in all 320
cells and rejects every unreviewed enclosed transparent pixel. The current
evidence has zero islands after the explicit coordinate repairs and an empty
enclosed-hole whitelist. All original 864 narrow-channel
candidates are classified: transient body channels are repaired and the 167
stable negative-space runs that remain are explicitly whitelisted with exact
coordinates and rationale.
`qa/verify-edge-heatmap.py` requires a nonblank contour block for every key,
facing, and pose; `qa/edge-heatmap.png` now covers all 320 cells, not only the
down-facing rows.
`qa/channel-review.json` classifies all 864 original 1-2px channel candidates.
Transient movement-only body channels are explicitly repaired; each surviving
negative-space run is whitelisted by exact cell, orientation, coordinate,
length, and rationale. `qa/verify-narrow-channels.py` rejects unclassified
current channels and includes an injected-channel negative test.

The aggregate evidence in this section predates the Avatar 1 override and did
not change the then-current row or frame mapping. The current six-column Avatar
1 mapping and its scoped evidence are documented above; runtime integration is
complete and James accepted Avatar 1 cosy in the live game on 2026-08-28. That
acceptance does not extend to Avatar 1 fighting or avatars 2-16, whose rendered
gate remains pending.

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

The Aseprite file contains the prior complete five-column set: one `art` layer
and 320 frames at 125 ms per frame, grouped in key order with 20 frames per
key. It contains one `avatar-N` tag for each of the 16 opaque keys. Until a
new editable source is approved, the exact hashed PNG is authoritative for the
six-column Avatar 1 cosy override; the Aseprite tag must not overwrite it.

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
