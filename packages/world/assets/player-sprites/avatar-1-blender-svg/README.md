# Avatar 1 — concept approval, Blender MCP and SVG workflow

**Active stage: idle-v5 is ready for exact idle approval after producer inspection in actual Phaser.**
James has accepted higher-detail illustrated vector artwork at the same
on-screen size. The rendering-style clarification is resolved. Build and
refine the draft, inspect its actual Phaser rendering, and fix visible
quality problems before requesting approval. See
[D-059](../../../../../docs/DECISIONS.md#d-059--avatar-1-authoring-uses-blender-mcp-and-real-svg-pose-files).

## Current authority and scope

The [approved fresh concept-v2](concept/avatar-1-concept-v2.png) is the visual
authority. [Its approval record](concept/approval.json) binds James's
“Yes good concept move forward” to SHA-256
`8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92`.
That approval remains valid. No idle, animation or production integration
approval has been granted.

The [idle-v5 revision](idle-v5/README.md) owns the current construction and
review evidence. Its [decision record](idle-v5/review/user-decisions.json)
is pending and binds the exact reviewed draft. An isolated actual-Phaser draft
preview and the browser inspection needed to judge this in-game draft are
authorized. The accepted runtime asset and shared local runtime remain current.

The **idle-v3 and idle-v4 artistic passes and approval requests are withdrawn**.
Both fell below the approved concept. The v3 pose was rigid, the face
lifeless, the shading muddy and the profiles flat; v4's face and proportions
still failed. Neither revision established live-game quality. Their
[withdrawn v3 assessment](idle-v3/review/visual-qa.json) and
[withdrawn v4 assessment](idle-v4/review/visual-qa.json) preserve the previous
claims with the correction. Their technical parity is historical evidence.

`reference/approved-concept-turnaround.png` is a historical sprite turnaround,
not an approved concept. Its old filename preserves provenance only.
[The reference manifest](reference/reference-manifest.json) records the
correction. Do not use that turnaround, the rejected raster restart or
withdrawn v1–v4 output as the art authority for idle-v5.

## Required production sequence

1. **Fresh concept and explicit concept approval — complete.** Use exact
   concept-v2. A material concept redesign requires renewed concept approval.
2. **Build and refine illustrated Blender/SVG idles — complete for v5.** Author
   genuinely detailed vector forms on a 512×512 canvas through Blender MCP,
   save the editable native Grease Pencil `.blend` and export real SVG paths.
   Derive 256×256 PNGs at four times the logical density. Enlarging a 64×64
   colour grid into vector regions does not recover illustrated detail.
3. **Inspect the source and actual engine result — required before every
   handoff.** The producing agent must personally view the editable artwork,
   exact exports and actual Phaser render at real game CSS scale, using all
   four turns and representative light and dark town surfaces. Compare with
   concept-v2 at matched displayed figure height. Check natural pose, readable
   expression, clear shading, convincing directional form, clean edges and
   retained character identity. Record the engine screenshot, viewport/CSS
   scale, device pixel ratio, camera zoom, texture density, filtering and
   inspected source hashes. An export board is not an engine inspection.
4. **Apply the quality gate and iterate.** Ask: **“Is this in-game result
   obviously good enough to approve?”** If no, if the result has not been
   viewed, or if known visible defects qualify the answer, fix it and inspect
   the new engine result again. Rough, rigid, muddy, lifeless, flat, distorted
   or concept-inconsistent artwork stays in internal refinement. Independent
   review can help find defects; it does not replace the producer's judgment.
   Successful exports and matching costume details cannot establish quality.
5. **Obtain explicit approval of the exact four idles.** Only after the
   producer's source and actual-engine quality gates pass, freeze the four
   source/export hashes and engine evidence. Show the in-game draft with
   concept comparison and editable sources, then record James's separate
   approval. Any subsequent material art or rendering change invalidates the
   visual pass and requires another inspection. Do not animate before approval.
6. **Animate and verify.** Establish the rig, part ownership and hidden
   surfaces. Complete one walk direction with weight transfer, counter-swing,
   planted feet and scarf follow-through before extending the other views.
   Verify all 24 poses and actual engine loops; apply the same producer
   quality gate before the separate animated-art handoff approval.
7. **Integrate and obtain production game acceptance.** Production replacement
   remains a later World-lane step. Give James the current-checkout browser
   test after approved integration. The isolated draft preview is evidence of
   that draft's rendering, not acceptance of the canonical live game.

## Illustrated source and draft rendering contract

The approved concept determines appearance. The `.blend` is the editable
master; each SVG is a real vector pose export and PNGs are derived from it.
Preserve editable region geometry, source hashes, export settings and review
hashes. Current v5 regions are an editable illustration, not an animation rig;
animation requires anatomical part ownership and hidden-surface construction. SVGs must contain paths and fills, without embedded raster images,
external resources, filters or fonts.

| Property | Idle-v5 contract |
|---|---|
| Vector authoring canvas | 512×512 SVG units |
| Derived PNG cell | 256×256 pixels; density 4 |
| Displayed logical frame | 64×64 world units |
| Feet pivot | (32,56) logical; (128,224) in the PNG; origin (0.5,0.875) |
| Gameplay body | 24×24 world units, verified after density scaling |
| Preview | Actual Phaser, real town assets, camera zoom 2 and real game CSS scale |
| Alpha and palette | Smooth alpha; appropriate unrestricted palette |
| Avatar filtering | Linear; existing town texture treatment stays current |
| Shadow and registration | No baked shadow or per-facing auto-fit |
| Directions | Down, left, right, up |
| Later pose order | Idle, contact-left, passing-left, contact-right, passing-right, settle |
| Later playback | Walk 8 FPS; sprint 12 FPS |

This draft explicitly supersedes the earlier 64-pixel raster, binary-alpha,
24-colour and nearest-neighbour requirements for the illustrated avatar.
It preserves logical size, contact position and gameplay body. A later
six-column/four-row sheet at this density would be 1536×1024 pixels; animation
is not authorized by this contract. Do not normalize every future frame's
visible height: body bob and lifted feet must survive.

The isolated preview may use the World engine and town assets to verify the
art. It must not replace production assets, alter financial flows or claim
merge, deployment or canonical-game acceptance. See [workflow.json](workflow.json)
for the separate authoring, preview, user-approval and integration states.

## Historical evidence

- [Idle-v4 exact exports](idle-v4/review/idle-approval.png),
  [concept comparison](idle-v4/review/reference-comparison.png) and
  [source record](idle-v4/README.md) are withdrawn and unapproved. Its
  [rendering diagnosis](idle-v4/review/rendering-diagnosis.md) explains the
  earlier source/presentation limits; its then-pending style question is
  resolved by the current D-059 amendment.
- [Idle-v3 exact exports](idle-v3/review/idle-approval.png),
  [comparison](idle-v3/review/reference-comparison.png) and
  [sources](idle-v3/README.md) remain withdrawn historical evidence.
- Root `source/`, `svg/`, `review/` and `reference/studies/` belong to historical
  idle-v2. [Its decision record](review/user-decisions.json) is superseded and
  unapproved because it skipped the genuine concept gate. Old comparison
  captions do not confer concept authority or revive the approval request.
- `review/rejected-idle-v1/` preserves the rejected first result; its complete
  source remains at commit `110b26e`.

Historical scripts preserve reproducibility and must not overwrite withdrawn
reviews. Adapted tooling belongs to idle-v5 and must record exact approved
concept-v2 as its visual authority. Saved-master readback, SVG/PNG parity and
file checks describe source integrity only; none grants artistic approval.

## Tooling evidence

[Setup instructions](setup/README.md) and [setup evidence](setup/setup-report.json)
record Blender 5.2.1 LTS, Blender MCP 1.9.1, native Codex tools, protocol 5,
a matching add-on and disabled telemetry. Verify the live connection for the
current revision. Historical handshakes and export fixtures establish tooling,
not a new construction result or a visual pass.

## Current draft review

Open the [isolated Phaser preview](http://127.0.0.1:5173/), leave **Game size** selected, and switch the four facings and road/pavement/grass. **Close-up** is separately labelled. The preview runs four idles; movement does not claim walk animation.

[Producer review](idle-v5/review/visual-qa.json), [engine capture](idle-v5/review/engine/phaser-road-viewport.png), [concept comparison](idle-v5/review/concept-comparison.png), and [source workflow](idle-v5/source/README.md) bind this candidate. Run `python3 idle-v5/source/verify_review.py` before sending it. This checks evidence freshness and the required producer judgment; it does not automate aesthetic judgment.
