# Avatar 1 — native JRPG idle draft v6

Status: **withdrawn-quality-failed; no exact-idle candidate is ready**.

The producer withdrew the approval request after comparing the original sprite
reference and exact native output at matched visible character height. V6 is
visibly degraded: noisy clusters, a spindly silhouette, a muddy face and jagged
legs. The previous artistic pass was wrong. The user's question prompted a
reassessment; it is not recorded as a user rejection. The exact user decision
remains unset.

- [Corrected reassessment](review/reassessment.json) and [matched-height comparison](review/matched-height-reassessment.png)
- [Visual QA, with prior assessment preserved](review/visual-qa.json)
- [User decision — producer withdrawal, user decision unset](review/user-decisions.json)
- [Historical actual game capture](review/phaser-road-viewport.png)
- [Historical exact output inspection](review/idle-inspection.png)
- [Historical native source and pixel parity](review/source-parity.json)
- [Preserved Blender master](source/avatar-1.blend)

The original medium JRPG sprite reference still governs style, proportions
and elevated viewpoint; concept-v2 still governs identity/costume. The concept
and direction approvals remain valid. No idle approval or animation and
production integration authorization exists.

Before any new aesthetic pass, compare the original sprite reference and
**exact native output side by side at the same visible character height**,
recording those displayed subject heights. A large reference beside a tiny
game figure is not an adequate comparison. Exact native-pixel inspection and
actual game-scale engine inspection remain required as separate views.

Subsequent work must rebuild an intentional native-pixel silhouette, face
and major material clusters. Point-sampling oversized pseudo-pixel ImageGen
studies and patching only the face failed. No new method contract, revision
parameters, replacement artwork or approval is claimed by this correction.
Follow the [active workflow](../README.md).

The current source and exports are preserved as evidence of the withdrawn
revision. SVGs contain native filled paths, without embedded rasters, and the
64×64 PNGs matched the source pixels. Feet pivot is (32,56), and the physics
body is 24×24 world units. The shared palette has 32 authored colours, with
27 in the outputs. These technical properties do not establish artistic
quality. Historical construction used internal ImageGen studies, point/grid
registration, palette mapping and face/scarf patches, followed by contiguous
vector regions, Blender MCP Grease Pencil export and native SVG/PNG output.
The source partitions are not a completed animation rig.

Keep the prior reviewed hashes, artwork and original evidence intact. The
withdrawn decision and corrected visual assessment must make the pre-handoff
review check fail; do not rewrite historical evidence to restore its pass.
Animation remains blocked until a future exact four-idle candidate passes
the strengthened visual gates and receives explicit user approval.
