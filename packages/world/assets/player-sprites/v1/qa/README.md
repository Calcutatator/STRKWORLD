# Player sprite QA

This directory contains the isolated D-052 correction candidate for all 16
opaque avatar keys. It is awaiting independent orchestration review. It is not
a runtime-ready or rendered-acceptance claim.

The candidate covers all 16 sheets, 320 64x64 cells, four facings, and the
five-column idle/contact-left/passing-left/contact-right/passing-right contract.
The side-facing identity reconstruction is character-specific; no mirroring,
blanket zone copy, scale normalization, or global despeckle was used.

Mechanical gates recorded in `qa-report.json`:

- 320x256 RGBA sheets with binary alpha and fixed feet at `(32,56)`.
- At most 24 visible RGB colours per cell.
- Zero enclosed transparent islands after the explicit repair pass.
- Zero non-binary alpha cells, feet failures, or duplicated movement cells.
- All movement cells differ from their directional idle with changes reaching
  the directional hip gate; down/up rows include connected upper-silhouette,
  waist, hip and planted-foot changes so the walk is depth transfer rather than
  a horizontal splay. Visual weight transfer remains an independent review
  gate.
- All 320 cells pass an 8-connected detached opaque-component gate. Any
  disconnected island is rejected; `qa/detached-components.json` contains the
  complete evidence and has an empty whitelist.
- `verify-boundary-touch.py` rejects any opaque pixel on a logical-cell edge;
  the current evidence is in `qa/boundary-touch.json` with no whitelist.
- Per-key source reconstruction is pixel-identical across all 320 Aseprite
  cels in `aseprite-roundtrip.json`.
- `verify-aseprite-format.py` is a regression gate for the official compressed
  cel layout: it requires 64x64 WORD dimensions before zlib data and verifies
  every decoded cel against its transparent PNG cell.
- `rendered-coherence.json` records the visual gates that still require
  independent review; metrics alone do not accept identity or gait.

`explicit-pixel-repairs.json` is the audit trail for the exact named repairs:
133 enclosed-hole fills, 662 seam-material repairs, four isolated-pixel
removals, 64 D/U stride reconstructions, and six detached-component cell
repairs. These were authored by explicit cell/model operations, not by an
automated hole-fill or global filter.

Visual evidence:

- `all-characters-movement.png`: enlarged game-ground contact for all 16 keys.
- `background-readability.png`: deterministic grass, slate, paving, and brick
  backgrounds.
- `edge-heatmap.png`: opaque contour pixels for edge inspection.
- `avatar-1-walk.gif` through `avatar-16-walk.gif`: individual 20-frame loops.
- `character-1-walk.gif` through `character-8-walk.gif`: paired cosy/fighting
  loops.

The source is checked by deterministic binary decoding because no Aseprite
executable is available locally. Independent Aseprite reopen and rendered
browser acceptance remain orchestration/user gates.
