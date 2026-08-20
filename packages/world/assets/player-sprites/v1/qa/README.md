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
  the upper body; visual weight transfer remains an independent review gate.
- Per-key source reconstruction is pixel-identical across all 320 Aseprite
  cels in `aseprite-roundtrip.json`.
- `rendered-coherence.json` records the visual gates that still require
  independent review; metrics alone do not accept identity or gait.

`explicit-pixel-repairs.json` is the audit trail for the exact named repairs:
133 enclosed-hole fills, four isolated-pixel removals, and sixteen reviewed
large-character scanline repairs. These were authored by explicit cell/coordinate,
not by an automated hole-fill or global filter.

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
