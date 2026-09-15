# Avatar 1 — concept, sprite design and Blender/SVG workflow

**Active stage: idle-v6 is withdrawn after failed quality reassessment. No
candidate is ready for approval.** The producer and a fresh independent
reviewer compared the original sprite style and exact output at matched
visible character height. V6 is visibly degraded: noisy clusters, a spindly
silhouette, a muddy face and jagged legs. The previous artistic pass was wrong.
The producer has withdrawn the approval request; no user rejection is recorded.

The original concept and sprite-direction approvals remain valid. The
[v6 decision record](idle-v6/review/user-decisions.json) keeps the exact-idle
user decision unset and preserves its previously reviewed hashes. The
[reassessment](idle-v6/review/reassessment.json) and [matched-height comparison](idle-v6/review/matched-height-reassessment.png) records the corrected judgment;
the previous assessment is preserved in [visual QA](idle-v6/review/visual-qa.json).
The source and engine artifacts remain historical evidence. Their pixel
parity does not establish artistic quality or revive the withdrawn handoff.

Idle-v5 remains rejected; its artistic pass and approval request remain
withdrawn. See
[D-059](../../../../../docs/DECISIONS.md#d-059--avatar-1-authoring-uses-blender-mcp-and-real-svg-pose-files)
and the [recorded v5 rejection](idle-v5/review/user-decisions.json).

## Two references, with distinct roles

The [approved fresh concept-v2](concept/avatar-1-concept-v2.png) governs
**character identity and costume**. [Its approval record](concept/approval.json)
binds “Yes good concept move forward” to SHA-256
`8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92`.
That approval remains valid. Approving the concept did not approve rendering
a literal full-height illustration as the in-game character.

The [originally approved medium Avatar 1 sprite reference](reference/approved-concept-turnaround.png)
governs **sprite style, proportions and elevated game viewpoint**. Its
SHA-256 is
`f1de96b3038042aaca726c18ae87fe374e8dac2bbda7d0a2359d53f44ad08ed4`.
It remains distinct from fresh concept art, despite its old filename.
Correcting the mistaken concept label did not invalidate its legitimate
sprite-style role. The [reference manifest](reference/reference-manifest.json)
records the source roles. The [original brief recovery note](reference/original-style-recovery.md)
links the primary messages and the original medium-sprite approval.

The original brief is warm, lower-resolution **16-bit JRPG game cutouts**:
medium sprite proportions, a simple expressive face, deliberate readable
clusters, clean contours and limited detail suited to the elevated game
view. Avatar 1 uses the original medium proportions. Only Avatars 6 and 14
were intentionally chibi.

The [rejected v5 assessment](idle-v5/review/visual-qa.json) retains the entire
prior positive assessment under `priorAssessment`, including its exact
hashes, source/engine evidence and timestamps. V5's style, viewpoint, detail
and proportions did not satisfy the sprite brief. Native Blender source,
real SVG export and an actual Phaser capture established the tool path and
rendered output; they did not establish an appropriate artistic result.

## Required production sequence

1. **Fresh concept and explicit concept approval — complete.** Exact
   concept-v2 remains the identity/costume authority. A material character
   redesign reopens the concept approval gate.
2. **Translate the character into the original sprite design — v6 producer pass.** Internally compare the design with both
   references. Preserve the original medium proportions and elevated game
   viewpoint while translating the approved concept's identity and costume
   into a simple expressive face, readable clusters, clean contours and
   limited detail. Judge it as an actual warm 16-bit JRPG game cutout at the
   intended displayed size. Rebuild intentional native-pixel silhouette,
   face and major material clusters. Point-sampling oversized pseudo-pixel
   ImageGen studies and patching only the face failed to create coherent v6
   artwork. A literal scaled concept illustration also fails this gate. Refine internally until the translation works; do not ask the user
   to approve a known mismatch.
3. **Build and refine the four Blender/SVG idles.** Use native editable
   Grease Pencil geometry through Blender MCP, save the `.blend` and export
   real SVG paths with derived PNGs. The tool choice must serve the approved
   sprite design. V6 uses the native 64×64 construction contract below.
   Generative images are internal construction studies; the deliverables are
   native editable vector sources and their exact derived game outputs.
4. **Personally inspect the source and actual engine result.** Before every
   handoff, the producing agent must view the source, exact exports and
   actual Phaser output at real game CSS scale, across all four facings and
   representative light and dark town surfaces. Compare style, proportions
   and viewpoint against the original medium sprite reference, and character
   identity/costume against concept-v2. Record the inspected sources, actual
   captures, viewport, device pixel ratio, zoom, density and filtering.
5. **Apply the quality gate and keep refining failures.** Ask: **“Is this
   in-game result obviously good enough to approve?”** A no, an unviewed
   result, uncertainty, or a known design/quality defect requires more work
   and a new inspection. Before any aesthetic pass, place the **original
   sprite reference and exact native output side by side at the same visible
   character height**. Record those displayed subject heights. A large
   reference beside a tiny game figure does not establish resemblance.
   Also inspect exact native pixels and the actual game-scale engine result.
   Independent review can find problems; the producer owns the judgment. Matching clothes, clean exports and engine screenshots
   cannot substitute for the correct sprite design.
6. **Obtain explicit approval of the exact four idles.** Freeze the reviewed
   source/export hashes and engine evidence only after the internal design
   translation and visual quality gates pass. Show the actual in-game draft
   and both reference comparisons. User approval remains separate; animation
   does not start until it is explicitly granted. Material art/render changes
   invalidate the prior visual pass and require another inspection.
7. **Animate, inspect and obtain the later handoff approvals.** Establish
   anatomical part ownership and hidden surfaces; complete one convincing
   walk direction before the others. Check the actual animated engine loops
   before the separate animated-art and production-integration acceptance.

## Scope and source integrity

The requested authoring route remains Blender MCP and editable SVGs. A `.blend`
master, vector paths, derived PNGs, source/export parity and engine checks
are production tools. They do not choose the artistic style or grant approval.
Preserve editable geometry, source hashes, export settings and review records.
SVGs must contain real paths/fills without embedded raster images, external
resources, filters or fonts.

The accepted production asset and shared runtime remain current. V6 keeps
existing logical size, foot contact and gameplay body. Its implementation
contract restores native game pixels within the confirmed original brief:

| Property | Idle-v6 internal construction contract |
|---|---|
| Native vector/source canvas | 64×64; pixel-aligned SVG and Blender Grease Pencil geometry |
| Derived PNG and logical frame | 64×64; density 1 |
| Target visible idle figure | 50 pixels high, opaque target rows y=6 through y=55 |
| Feet pivot and origin | (32,56); origin (0.5,0.875) |
| Gameplay body | 24×24 world units |
| Palette | One global maximum of 32 opaque authored colours across the four idles |
| Alpha and avatar filtering | Binary alpha; nearest filtering |
| Actual engine inspection | Real town context, camera zoom 2 and real game CSS scale |
| Registration | No baked shadow or per-facing auto-fit |

The global 32-colour maximum provides limited headroom over the originally
accepted actual idles' 24–28 colours; it is a ceiling, not a target to fill.
The pixel/height constraints do not replace visual judgment of the original
medium proportions, elevated viewpoint, readable clusters or expressive face.
Both reference comparisons remain mandatory. Any generated images are
internal studies only; final SVGs must have native paths with no embedded
rasters. V5's rejected parameters remain in its historical records.

The future six-pose order and 8 FPS walk / 12 FPS sprint remain current.
Animation stays blocked until James explicitly approves the exact four v6
idles after their source and in-game visual quality gates pass.

Isolated actual-Phaser visual QA remains part of draft production. It must use
the real town context and displayed game scale, without changing financial
flows or claiming canonical-game acceptance. No idle approval, animation,
production asset replacement, merge or deployment is authorized by v5's
historical inspection. [Workflow state](workflow.json) keeps those gates separate.

## Historical evidence

- [Idle-v6 sources and record](idle-v6/README.md) are withdrawn by the producer
  after failed quality reassessment. Exact user approval remains unset.
  Prior reviewed source/export hashes and technical pixel-parity evidence
  are retained; no new method contract or revision parameters are selected
  by this correction.
- [Idle-v5 sources and record](idle-v5/README.md),
  [exact export inspection](idle-v5/review/idle-inspection.png),
  [engine capture](idle-v5/review/engine/phaser-road-viewport.png) and
  [concept comparison](idle-v5/review/concept-comparison.png) are rejected
  historical evidence. The positive producer judgment is withdrawn, and
  `idle-v5/source/verify_review.py` must reject the corrected review. Do not
  rewrite historical evidence merely to make that check pass.
- [Idle-v4](idle-v4/README.md) and [idle-v3](idle-v3/README.md) remain withdrawn
  and unapproved. Their prior technical results do not revive their art passes.
- Root `source/`, `svg/`, `review/` and `reference/studies/` belong to historical
  idle-v2. [Its decision record](review/user-decisions.json) remains superseded
  and unapproved because it skipped the fresh concept gate. Recognizing the
  original reference's sprite-style role does not retroactively approve v2.
- `review/rejected-idle-v1/` preserves the first rejected result; its complete
  source remains at commit `110b26e`.

[Setup instructions](setup/README.md) and [setup evidence](setup/setup-report.json)
record the historical Blender/MCP installation and export fixtures. Verify
tool availability when construction resumes; those records establish no new
artwork, artistic pass or approval candidate.
