# Player sprite QA

> **Avatar 1 cosy override.** The aggregate evidence below describes the prior
> five-column complete set. The current approved six-column `avatar-1.png` is
> governed by `avatar-1-cosy-six-column/qa-cells.json` and
> `avatar-1-cosy-six-column/eye-anchor-qa.json`; the exact PNG hash is pinned by
> `packages/world/src/avatar-asset.test.ts`. Do not use the historical Avatar 1
> Aseprite cels or aggregate reports to overwrite that approved PNG.
> The historical 24-colour aggregate cap remains the default for Avatar 2-16;
> Avatar 1 cosy has an explicit per-key maximum of 29 recorded in the manifest.

This directory contains the isolated D-052 correction candidate for all 16
opaque avatar keys. It is awaiting independent orchestration review. It is not
a runtime-ready or rendered-acceptance claim.

The candidate covers all 16 sheets, 320 64x64 cells, four facings, and the
five-column idle/contact-left/passing-left/contact-right/passing-right contract.
The side-facing identity reconstruction is character-specific; no mirroring,
blanket zone copy, scale normalization, or global despeckle was used.

Mechanical gates recorded in `qa-report.json`:

- 320x256 RGBA sheets with binary alpha and fixed feet at `(32,56)`.
- At most 24 visible RGB colours per cell in the historical five-column set.
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
- `verify-silhouette-holes.py` performs a four-connected exterior flood fill
  over all 320 cells and rejects unreviewed enclosed transparency. Its exact
  zero-island evidence is `interior-holes.json`; the repair ledger records the
  initial 449 plus 60 cross-gate follow-up coordinate repairs and has no
  enclosed-hole whitelist.
- `verify-edge-heatmap.py` rejects omitted or blank evidence blocks. The
  heatmap uses a 4x4 key-panel grid and contains 320 nonblank contour blocks
  covering every facing and pose. Its negative test rejects an injected blank
  block.
- `verify-background-readability.py` correlates every one of the 16 full
  64x64 down-idle cells across four row-separated background boards; it
  derives the occupied board geometry and rejects fragment, quarter-cell, or
  blank-lower-canvas layouts.
- `channel-review.json` classifies all 864 original narrow-channel candidates.
  Transient movement-only body channels are explicitly repaired; the 167
  stable negative-space runs that remain are listed by exact cell, orientation,
  coordinate, length, anatomical cluster, and rationale. Follow-up-repaired
  runs remain classified in the complete ledger but are not whitelisted.
  `verify-narrow-channels.py` rejects any current channel outside that
  whitelist, and its `--self-test` proves injected and stale whitelist entries
  fail.
- `verify-qa-report.py` recomputes all 320 per-cell metrics and recorded
  whole-body aggregates from the exact PNG sheets. Its `--self-test` rejects
  mutated per-cell and aggregate values.
- `rendered-coherence.json` records the visual gates that still require
  independent review; metrics alone do not accept identity or gait.

`explicit-pixel-repairs.json` is the audit trail for the exact named repairs:
642 enclosed-hole fills across the initial and cross-gate passes, 1,088
transient channel repairs, 25 per-cell palette remaps, 662 seam-material
repairs, four isolated-pixel removals, 64 D/U stride reconstructions, two D/U
depth repairs, six weapon-boundary repairs, and six detached-component cell
repairs. These 2,499 ledger entries are explicit cell/coordinate operations,
not a blanket filter.

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
