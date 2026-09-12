# Avatar 1 restart: authoring and review

**Date:** 2026-09-12. **Status:** proposed production flow and first-draft
review, requested by James. No runtime replacement, tool adoption or rendered
acceptance is implied. Draft pixels and their actual checks are recorded in
the [draft package](../../packages/world/assets/player-sprites/avatar-1-restart-2026-09-12/README.md).

## Recovered flow and diagnosis

The [original sprite task](codex://threads/01a01a58-1f53-7320-bbe2-4dd7fbb92615)
established review of all four exact idle views together, followed by movement
authoring and exact-cell QA. This restart returns to that first approval gate.
Avatar 1 remains the medium-size Teal Scarf Runner: warm city clothing, scarf,
travel coat and satchel, as described in the
[studio notes](../../packages/world/assets/player-sprites/v1-review/source/studio-notes.md).

The earlier [workflow investigation](avatar-animation-workflow.md) found
movement concentrated below the hips and visible cutoff/bright-edge defects.
The original task also rejected wide side passing legs, rocking or sliding
weight transfer, a frozen whole head and a settle-to-idle hitch. Mechanical
checks did not establish a convincing gait. The
[generation provenance](../../packages/world/assets/player-sprites/v1-review/source/generation-source.md)
records another failure: generated sheets retained backgrounds despite a
transparency request. A model's requested layout or alpha is not an export
guarantee.

The improvement is to resolve identity at final pixel size, then author and
review a single direction before multiplying it across the sheet. Use an
individual generation/edit for each pose, with approved reference pixels and
explicit anatomical intent. Keep generated references, exact game cells and
review composites separate; derive every preview from the exact cells being
reviewed.

## Current runtime contract

The [D-052 August 28 amendment](../DECISIONS.md#d-052--avatar-animation-contract-and-avatar-studio-f-toggle),
[asset manifest](../../packages/world/assets/player-sprites/v1/manifest.json)
and [World resolver](../../packages/world/src/avatar-visual.ts) agree:

- Avatar 1 cosy uses a 384×256 sheet: four rows `down`, `left`, `right`, `up`;
  six 64×64 cells per row: `idle`, `contact-left`, `passing-left`,
  `contact-right`, `passing-right`, `settle`.
- Feet pivot is `(32,56)`; the runtime-owned contact body is 24×24. Use binary
  transparent alpha, no baked shadow and nearest-neighbour integer scaling.
- Walking plays all six columns at 8 FPS; sprint playback is 12 FPS. Idle is
  column zero of the selected facing.
- Avatar 1 fighting and avatars 2–16 retain their five-column 320×256 sheets.
  The exact approved Avatar 1 cosy PNG has a scoped 29-colour-per-frame
  exception; the other sheets retain 24. This note grants no palette exception
  to new pixels.

The approved Avatar 1 PNG remains the current source authority. The historical
five-column Aseprite file cannot reproduce its six-column override. A new
editable source must reproduce the new accepted cells before a later handoff;
it must not overwrite the existing approved PNG during this draft stage.

## Recommended stages

1. **Four idle views, one approval.** Present fresh, exact 64×64 down/left/right/up
   cells together at native size, 2× game scale and enlarged nearest-neighbour
   scale. Check consistent height, face, palette, scarf and satchel on light,
   dark and representative game backgrounds. James approves the complete idle
   set before animation begins.
2. **One full direction.** Generate the two contact poses individually, then
   passing poses and settle, using that facing's approved idle as reference.
   Plan planted feet, hip movement, arm counter-swing and scarf follow-through.
   Preserve facial identity while allowing intentional whole-body motion.
   Review the complete six-frame loop and its last-to-first transition before
   extending the approach.
3. **Remaining directions.** Apply the reviewed gait to each facing with
   separate poses. Preserve asymmetric clothing and accessory placement; a
   mirrored view is not sufficient final evidence. Compare all four directions
   again for identity and proportions.
4. **Exact export and review.** Assemble the 24 accepted cells deterministically.
   Record filenames, order, durations, source and sheet hashes, and raw-RGBA
   crop parity. Keep an editable source that reproduces those pixels. Preview
   at the runtime's 8 FPS, with exact timing where the preview format supports
   it; label any approximation. Integration and user-run in-game acceptance
   remain subsequent, separate work.

## Evidence and optional tooling

Automated QA should report actual dimensions, cell count, alpha, bounds,
palette, anchors and export parity. Connected-component, holes and narrow-gap
checks are useful defect detectors; intentional negative space needs explicit
visual review. Pixel-difference thresholds cannot prove weight transfer.
Record subjective gait and identity findings separately, with the reviewed
artifact hash. Never promote a manually edited “pass” field into automated
evidence or treat draft approval as game acceptance.

The official [Aseprite CLI documentation](https://www.aseprite.org/docs/cli/)
supports batch export, fixed sheet dimensions, frame/tag selection and JSON
metadata. These are suitable controls for a reproducible export recipe once
the executable and new source are available; they do not author convincing
poses. [PixelOver's official introduction](https://docs.pixelover.io/manual/introduction/)
documents bone and keyframe animation. It remains an optional motion-reference
tool; no rigging workflow, installation or dependency is adopted here. Both
official pages were checked on 2026-09-12; local application availability was
not rechecked for this documentation update.
