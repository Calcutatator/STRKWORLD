# Avatar 1 native64 Phaser preview

This isolated page renders the actual four v6 idle PNGs through Phaser 4.2.1
on the game's street map. The current decision is **internal-refinement**,
`readyForReview: false`, with no exact-idle approval or visual pass. That state
intentionally permits the producer to inspect the actual game rendering.
A decision whose status is `rejected` or starts with `withdrawn` prevents the
scene from booting and shows a withdrawal notice beside the references.

The exact PNG contract is **`../frames/{down,left,right,up}/idle.png`**,
matching the v6 source verifier and the historical nested frame layout.
Every file must be 64×64; missing or incorrectly sized files produce a visible
failure instead of displaying substitute art.

## Run

From the art worktree, using a supported Node runtime:

```sh
node packages/world/assets/player-sprites/avatar-1-blender-svg/idle-v6/preview/serve.mjs
```

The default URL is `http://127.0.0.1:5186/`. This separate strict port leaves
the v5 preview and canonical app alone. `STRKWORLD_PREVIEW_PORT` can select
another explicit port; an occupied port causes startup to fail. The launcher
uses local installed dependencies or sibling `STRKWORLD/node_modules`.
`STRKWORLD_PREVIEW_DEPS` overrides that dependency directory. It loads no
project environment files, wallet, React shell, lobby or backend.

Check bundling without starting a server:

```sh
node packages/world/assets/player-sprites/avatar-1-blender-svg/idle-v6/preview/serve.mjs --build-check
```

`--metadata-check` prints the current hash-bound metadata and reference checks
without launching a server. Missing frames remain explicitly marked missing.

The ignored `.build-check` output is a compiler check; the live metadata
endpoint requires the preview server. No v5 files, accepted game assets or
production code are changed by this preview.

## Reference roles

Both references appear alongside the actual game view and open at full size
when clicked. `reference/approved-concept-turnaround.png` is the authority
for the original medium sprite style, proportions, elevated viewpoint,
simple expressive face and clear pixel shapes. Despite its historical filename,
it is a sprite-style reference, not fresh concept art.

Exact `concept/avatar-1-concept-v2.png` is the approved authority for character
identity and costume. Its detailed illustration must be translated into the
original sprite language. Direction approval does not approve any v6 idle.
The preview verifies both reference hashes against the v6 decision record.
The four rendered idles are the eventual approval subject; the references
remain supporting comparisons.

## Rendering and reused world data

The four 64×64 PNG cells use density **1**, object scale **1**, origin
**(0.5,0.875)** and feet **(32,56)**. The scene requires a 24×24 Arcade body
with source offset (20,44), then reads back its live world size and center.
At camera zoom **2**, a complete logical cell occupies **128 CSS pixels** when
the recorded canvas/CSS ratio is 1:1. The intended 50-pixel figure occupies
100 CSS pixels at that scale. It remains the producer's responsibility to
verify the actual painted bounds and visual result.

Avatar and town textures use **NEAREST**. The native64 source contract requires
binary alpha and at most 32 opaque authored colours across all four idles;
source validation owns those PNG checks. Pixel-art rendering and camera
rounding remain enabled. Label textures independently use resolution 4 and
LINEAR filtering, with 7-unit text and a 0.75-unit stroke.

The scene imports the actual street map, tile kinds and collision data from
`src/map/street.ts`, the audited Kenney atlas and runtime texture builder from
`src/kenney-urban.ts`, tile indices and door layout from
`src/scenes/street-scene.ts`, and the game's movement/facing helpers. It creates
a separate Phaser scene without activating room, wallet or financial flows.

At zoom 2, the Road comparison anchor is X648 with 48-unit spacing, placing
the four figures at X576, X624, X672 and X720 between the building approaches.
Pavement and Grass use X544 and 72-unit spacing. Close-up spacing is 48 units.
Surface foot Y values are Road 500, Pavement 600 and Grass 696. The underlying
map is unchanged.

Contact shadows remain separate Phaser graphics at depth 9 beneath the
depth-10 figures. The recipe is three concentric ellipses in `#14251e`:
24×6 at alpha .055, 18×4.5 at .065, and 12×3 at .085, centered at feet plus
(0,-1.5) world units. Shadows follow player position after Arcade's post-update
and match each figure's visibility. They are part of the inspected engine
composition and are not baked into the sprite.

## Producer inspection

Use a viewport at least 1280 CSS pixels wide to inspect the four facings with
both reference cards beside the town. **Game size** is the required camera
zoom 2. **Close-up** is explicitly zoom 4. Road, Pavement and Grass are actual
map surfaces. WASD/arrows select one movable avatar using directional idle
poses; no walk animation exists or is implied.

Wait for `window.avatarDraft.ready`, capture the actual canvas and record
`window.avatarDraft.evidence()`. The evidence contains the worktree path,
branch and HEAD; source/PNG/reference/decision/preview hashes; actual filtering;
source density; live geometry; viewport/DPR/canvas ratio; surface layout; and
shadow recipe. `setFacing`, `setSurface`, `setZoom` and `setLineup` support
repeatable inspection. Reload after every source, export or decision change
so the current file hashes and rendered pixels agree.

The producer must inspect every actual facing at game scale on the town
surfaces against **both** reference roles. Keep refining any visible style,
perspective, proportion, face, cluster or contour defect. A running scene,
valid source, screenshot or another agent's assessment cannot establish
artistic quality. Only after that personal inspection passes may the decision
record be advanced to a candidate; user idle approval remains a separate gate.

Building this page records no artistic pass, approval, animation permission
or canonical live-game acceptance.
