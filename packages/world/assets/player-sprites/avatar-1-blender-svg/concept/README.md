# Avatar 1 — fresh concept v2

**Status: approved by James on 2026-09-12.** His exact response was “Yes good concept move forward”. This authorizes the new idle-v3 Blender/SVG construction and internal likeness QA, not final sprite or animation approval.

[Concept artwork](avatar-1-concept-v2.png) · [Initial generation prompt](prompt.txt) · [Continuity correction prompt](revision-v2-prompt.txt) · [Approval record](approval.json)

This is a new high-resolution illustrated character proposal created with the built-in ImageGen tool. No previous sprite or turnaround was supplied as an image reference. The second revision edits only the freshly generated first concept to correct costume continuity. The sheet presents a full-body three-quarter design, rear costume view and face study for the Teal Scarf Runner.

James approved the character's face, hair, body proportions, teal scarf, travel clothing and leather equipment in this exact concept. The separate 64×64 idle-cell and animation gates remain open.

## Authorized next step

Use this exact image as the visual reference for new Blender MCP authoring and editable SVG sprite exports under `../idle-v3/{source,svg,frames,review}`. Internally compare the resulting four idle facings against the concept, including their actual game-scale appearance, and iterate before asking for the separate idle approval. No animation until James explicitly approves those idles; then one complete walk direction precedes the remaining directions and art handoff.

The historical file named `reference/approved-concept-turnaround.png` was incorrectly called concept art. Its old approval history does not approve this concept or authorize downstream production. Historical idle-v2 is superseded and unapproved.

## Provenance

- Generated on 2026-09-12 with built-in `image_gen.imagegen`; no CLI fallback.
- Original output was copied without alteration into this directory.
- Resolution: 1536×1024.
- SHA-256: `8c0d58a07d1372d2e8c9bcdbddac6e997763a8ffd2b910be83e8ec47b69f1c92`.
- The explicit concept approval in `approval.json` is separate from the internal quality review in `visual-qa.json` and does not approve later sprite exports. The first concept remains as the superseded generation input, with its record in `concept-v1-record.json`.
