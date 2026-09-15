# Avatar 1 — fresh concept v2

**Status: approved by James on 2026-09-12.** His exact response was “Yes good concept move forward”. This approves the illustrated character concept as a design reference. It does not approve a literal illustrated figure as the in-game sprite; see the 2026-09-15 reference-role correction below.

[Concept artwork](avatar-1-concept-v2.png) · [Initial generation prompt](prompt.txt) · [Continuity correction prompt](revision-v2-prompt.txt) · [Approval record](approval.json)

This is a new high-resolution illustrated character proposal created with the built-in ImageGen tool. No previous sprite or turnaround was supplied as an image reference. The second revision edits only the freshly generated first concept to correct costume continuity. The sheet presents a full-body three-quarter design, rear costume view and face study for the Teal Scarf Runner.

James approved this character concept. Preserve its identity, hair, teal scarf, clothing and leather equipment while translating it into the originally requested medium JRPG sprite style. Concept-level anatomy and shading must not be copied literally into the small game sprite. Exact sprite and animation approval remain separate.

## Authorized next step

Use this exact image as the character reference for Blender MCP/SVG sprite authoring. The prior idle-v3 through idle-v5 outputs are withdrawn. Apply the separately recorded original sprite-style reference before producing new game-facing poses. Internally compare the resulting four idle facings against the concept, including their actual game-scale appearance, and iterate before asking for the separate idle approval. No animation until James explicitly approves those idles; then one complete walk direction precedes the remaining directions and art handoff.

The historical file named `reference/approved-concept-turnaround.png` was incorrectly called concept art. Its old approval history does not approve this concept or authorize downstream production. Historical idle-v2 is superseded and unapproved.

## Provenance

- Generated on 2026-09-12 with built-in `image_gen.imagegen`; no CLI fallback.
- Original output was copied without alteration into this directory.
- Resolution: 1536×1024.
- SHA-256: `8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92`.
- The explicit concept approval in `approval.json` is separate from the internal quality review in `visual-qa.json` and does not approve later sprite exports. The first concept remains as the superseded generation input, with its record in `concept-v1-record.json`.

## Reference-role correction — 2026-09-15

The user rejected v5 because it did not match the originally requested sprite design. Its full-height illustrated turnaround was treated as a game sprite without the required design translation. The [original medium sprite reference](../reference/approved-concept-turnaround.png) now has an explicit, separate style/proportion role in [the reference manifest](../reference/reference-manifest.json). It is still not fresh concept art. [Recovered original instructions](../reference/original-style-recovery.md) explain both roles. Concept-v2 remains approved; no replacement sprite is ready for approval.
