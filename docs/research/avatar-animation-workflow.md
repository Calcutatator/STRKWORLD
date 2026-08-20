# Avatar animation authoring workflow

**Date:** 2026-08-20
**Scope:** research guidance for the D-052 replacement animation handoff; no
tool installation, dependency adoption, asset change or runtime change is
authorized by this note.

## Observed project evidence

The supplied `Screen Recording 2026-08-20 at 11.46.57.mov` was inspected
directly: `ffprobe` reports a 5.8285-second H.264 recording at 264x296 and
approximately 57.7 fps, with AAC audio. The recording and its extracted
contact sheet show user-visible cutoff and white-edge contamination, and do
not establish that the existing walk reads as a convincing gait. Separately,
a direct comparison of the older movement source frames found changes confined
approximately to `y>=48` through `y=56`; the torso, hips and overall silhouette
changed little. That source evidence explains the motion problem more directly
than the file format: the feet move, but the character's weight and whole-body
pose do not clearly travel through a walk cycle.

The current machine also has no `aseprite`, `pixelorama` or `pixelover`
executable on `PATH`, and no matching application was found under
`/Applications`. The repository's existing Aseprite source and PNG/JSON QA
remain evidence, but this environment cannot currently re-export them through
any of those authoring applications.

These are local observations, not general animation rules and not evidence
that any candidate tool would fix the gait automatically.

## Public guidance relevant to the diagnosis

- The [Pixel Art Walk Cycle tutorial](https://pixelartapp.com/walk-cycle)
  describes alternating contact and passing poses, a small vertical body shift,
  arm counter-swing, silhouette checks, nearest-neighbour presentation and
  repeated loop review. It warns that moving details without clear pose and
  timing changes produces weak or ambiguous motion.
- The [Monmouth University walk-cycle notes](https://animation.monmouth.edu/instruct/animation/walk-cycle/)
  separate contact, passing, down and push-off positions, recommend recording
  reference movement, and warn against including the duplicated endpoint in a
  looping preview. Their 24-frame examples are traditional animation guidance,
  not a requirement to expand D-052 beyond its five columns.
- The official [Aseprite CLI documentation](https://www.aseprite.org/docs/cli/)
  supports batch export, frame/tag selection, fixed sheet geometry, JSON data,
  filename templates, and scripted operations. That makes it suitable for a
  deterministic export and inspection gate once an executable is separately
  approved and available; it does not design poses.
- Pixelorama's [official product page](https://pixelorama.org/) documents
  frame-by-frame animation, onion skinning, frame tags, layers, spritesheet/GIF
  export and bulk command-line export. It is a credible manual pixel-authoring
  alternative, but adopting it would require a separate source-format and
  reproducibility decision.
- The [PixelOver introduction](https://docs.pixelover.io/manual/introduction/)
  documents keyframes, bone rigging, inverse kinematics, pixel-oriented effects
  and spritesheet export. Its [2D bones tutorial](https://docs.pixelover.io/tutorials/bones_animation/)
  starts by splitting artwork into parts, filling hidden areas and rigging a
  hierarchy before posing keys. That can accelerate motion exploration, but it
  introduces a different editable-source model and still requires manual
  pixel/silhouette review after deformation.
- [`MalloyTheDev/aseprite-mcp`](https://github.com/MalloyTheDev/aseprite-mcp)
  is an unofficial third-party MCP server. Its own README says it generates Lua
  scripts and drives Aseprite batch mode to mutate real `.aseprite` files and
  export sprites. Its broad write surface and additional runtime/tool trust are
  not needed for the bounded deterministic workflow below, so it is **not
  adopted**.

## Ranked gait and QA problems

| Rank | Issue | Severity | Observed frequency | Confidence | Recommended move |
|---:|---|---|---|---|---|
| 1 | Whole-body gait readability | Critical | Persistent through the inspected MOV; legacy movement diffs were confined approximately to `y>=48..56` | High | Author contact and passing frames as distinct hip, torso, head, arm and accessory poses, not translated feet |
| 2 | Planted-foot and travel logic | High | Repeated across the inspected legacy movement sequence | High | Move vertical legs on the depth axis and side legs on x; keep at least one sole planted at `(32, 56)` |
| 3 | Alternation and loop cadence | High | The reviewed loop did not establish distinct weight-transfer beats | Medium | Make left/right contact and passing poses visibly distinct; preview repeated cycles without a duplicated endpoint at game cadence |
| 4 | Silhouette, carried-item and edge continuity | High | Cutoff and white-edge contamination are visible in the recording/contact extraction; cross-character weapon continuity is not yet fully sampled | High for visible defects; medium for set-wide frequency | Review light/dark-background silhouettes, clipping, hand/weapon continuity and counterbalance per frame |
| 5 | Mechanical consistency across sixteen keys | Medium | Existing D-049 QA proves the old geometry; D-052 replacement files do not yet exist | High | Re-run dimensions, order, alpha, feet/bounds, palette, bright-edge and hash checks without treating them as gait acceptance |

Mechanical conformance in rank 5 cannot substitute for the motion and
readability problems in ranks 1-4.

## Tool comparison for this handoff

| Tool | Strong fit | Main limitation for STRKWORLD | Current conclusion |
|---|---|---|---|
| Aseprite CLI | Deterministic tag/frame export, fixed 320x256 sheet geometry, JSON metadata and repeatable QA inputs | No local executable; CLI cannot supply the missing poses | Preferred export/verification path **if separately made available**, not an installation decision |
| Pixelorama | Manual frame-by-frame pixel editing, onion skinning, tags and spritesheet export; official site also advertises bulk CLI export | Would add a second editable-source/tool workflow and needs its own round-trip proof | Viable authoring alternative, not adopted here |
| PixelOver | Fast pose and timing exploration through keys, bones, IK and spritesheet export | Requires split-part rigs/hidden-area art and deformation cleanup; does not preserve the current Aseprite source model automatically | Useful prototype/reference option, not the final deterministic source by default |
| Unofficial Aseprite MCP | Agent-driven headless edits to Aseprite files and exports | Unofficial dependency with broad mutation authority; still depends on Aseprite and does not make animation judgement reliable | Do not adopt |

## Recommended bounded workflow

Use **pose-first, deterministic five-column authoring**. D-052 remains the
authority: each facing row is exactly `idle`, `contact-left`, `passing-left`,
`contact-right`, `passing-right`; each avatar sheet is 320x256, and the sixteen
sheets total 320 logical frames.

1. Lock the idle, feet point and 24x24 gameplay body. The visible 64x64 art may
   overhang that body, but animation must not move gameplay coordinates.
2. Draw the two contact poses first as genuinely different whole-body extremes.
   Pin the planted sole to `(32, 56)` and check hip continuity before adding
   polish.
3. Draw each passing pose as its own weight-transfer pose between those
   contacts. Do not derive the cycle by moving only pixels in `y=48..56`, and
   do not treat mirroring as final for asymmetric weapons, clothing or hands.
4. Review a repeated five-column loop at the intended game cadence on light
   and dark backgrounds. Check foot skating, body bob, arm counter-swing,
   silhouette, direction, accessory continuity and the transition back to the
   first movement pose.
5. Export in the exact D-052 order through a deterministic, recorded command or
   manual export recipe. If Aseprite CLI later becomes available, use its
   fixed-sheet/tag/data options rather than an MCP mutation layer.
6. Run mechanical QA after every export: dimensions/grid, frame count/order,
   alpha, feet/bounds, clipping, palette/bright-edge checks and per-frame
   hashes. Then require a fresh user-run in-game review; passing mechanical QA
   alone is not rendered acceptance.

## Opportunity map

| Horizon | Bounded opportunity | Exit evidence |
|---|---|---|
| This prototype gate | Pose one representative D-052 five-column cycle by hand, prioritizing contact/passing separation, planted feet and whole-body weight transfer before polish | Repeated light/dark-background preview and source-frame diff show readable alternating poses beyond the lower `y=48..56` strip; no cutoff or bright-edge contamination |
| Full replacement handoff | Apply the approved pose vocabulary to all sixteen keys and four facings while preserving 64x64 cells, 24x24 gameplay bodies, fixed feet, transparent/no-shadow art and exact 320x256 sheet order | Deterministic sixteen-sheet export plus source/tags and mechanical QA, followed by fresh user-run in-game acceptance |
| Optional deeper tooling | Separately evaluate Aseprite CLI export automation, Pixelorama authoring or a PixelOver motion prototype only if the manual gate exposes a repeatability or throughput problem | A scoped comparison with round-trip proof and an explicit installation/source-format decision; the unofficial Aseprite MCP remains outside the recommended path |

This note recommends workflow structure, not an application. Selecting or
installing Aseprite, Pixelorama, PixelOver, an MCP server or any new project
dependency remains a separate decision.
