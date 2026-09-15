# Avatar 1 isolated Phaser draft

**Status: v5 withdrawn for design mismatch on 2026-09-15.** The current page
shows the original sprite-style reference and approved character concept,
without mounting Phaser or asking for sprite approval. The previous in-game
render and captures remain historical. The renderer below is retained for
provenance; a rejected/withdrawn decision prevents it from booting.


This page renders the current four `idle-v5/frames/*/idle.png` files through
the installed Phaser 4.2.1 WebGL engine in the real street map. It is an
internal art preview authorized by D-059. It does not change the accepted
runtime avatar, the web app, or the shared local runtime. Loading and inspecting
it establishes an isolated engine result; it is not canonical live-game
acceptance or a visual quality pass.

Run from the art worktree with a supported Node runtime:

```sh
node packages/world/assets/player-sprites/avatar-1-blender-svg/idle-v5/preview/serve.mjs
```

The default address is `http://127.0.0.1:5173/`. The port is strict: an existing
server is never replaced or silently bypassed. Set `STRKWORLD_PREVIEW_PORT`
explicitly if a separate port is needed. The launcher first looks for local
installed dependencies, then the sibling canonical `STRKWORLD/node_modules`;
`STRKWORLD_PREVIEW_DEPS` overrides that dependency directory. It disables
project environment-file loading and loads no React shell, wallet, backend,
lobby or external service.

`node .../preview/serve.mjs --build-check` checks bundling without starting a
server. Its ignored `.build-check` directory is a compiler result only; the
live metadata endpoint requires the preview server.

## What is reused

- `src/map/street.ts`: actual 48×28 district layout, 32-unit tiles, collision
  kinds, spawn coordinates, exterior labels and door zones.
- `src/kenney-urban.ts` and the audited Kenney PNG: the same source rectangles,
  runtime texture construction and nearest filtering used by the game.
- `src/scenes/street-scene.ts`: exact tile-index mapping and door overlay layout.
- `src/movement-input.ts` and `src/street-movement.ts`: the game's normalized
  movement speeds and direction selection.

The page creates a separate Phaser scene so no runtime asset selection, room
interaction, lobby event or financial flow changes. It does not pretend a
composited backdrop is a game screenshot.

## Density and geometry

The four 256×256 PNG cells have density 4 and are shown at object scale 0.25.
That preserves the game's 64×64 logical cell, origin (0.5, 0.875), feet (32,56)
and camera zoom 2. A complete cell is therefore 128 CSS pixels at a verified
1:1 canvas/CSS ratio. The figure itself occupies only its painted portion of
that cell.

The Arcade body is set to 96×96 source pixels with offset (80,176), then
read back from Phaser as 24×24 world units centered on the feet. The scene
fails visibly if that invariant does not hold. Per-avatar textures use LINEAR
filtering and their exported smooth alpha. Town textures retain NEAREST.
Existing game `pixelArt` and camera rounding remain in effect; texture
filtering is explicitly per source.

Each displayed avatar has a separate Phaser ground-contact shadow at depth
9, below the depth-10 figure. Three concentric ellipses use colour `#14251e`
at widths/heights/alpha of `24×6 / 0.055`, `18×4.5 / 0.065` and
`12×3 / 0.085`, all in world units. They share an anchor at the feet plus
`(0,-1.5)`. The player shadow follows its live position after Arcade's
post-update synchronization; lineup shadows follow each figure and the
corresponding visibility state. These shadows are part of the inspected
engine composition and are not baked into the SVG or PNG artwork.

Facing captions use a 7-unit font, text resolution 4, LINEAR filtering on
each label texture and a restrained 0.75-unit stroke. At game zoom 2, Road
uses comparison/player anchor X 648 with 48-unit lineup spacing, placing
the four figures at X 576, 624, 672 and 720 between the building approaches.
Pavement and Grass use anchor X 544 with 72-unit spacing; the grass figures
stay west of the central pavement path. Close-up spacing remains 48 units.
The per-surface anchors and spacing are recorded in inspection evidence.
The original town map and its textures remain unchanged.

## Inspection

Use a desktop viewport at least 1050 CSS pixels wide to inspect all four
facings together. Default **Game size** is camera zoom 2. **Close-up** is
explicitly camera zoom 4 and cannot establish game-size quality. **Road**,
**Pavement** and **Grass** place the complete figure on those actual map
surfaces. WASD/arrows switch to one movable avatar with directional idle
poses; no walk animation is implied.

The producer must inspect every facing at Game size on Road and Pavement,
then compare character identity and visible quality against the approved
concept at matched figure height. Keep defects internal and refine the art.
This page has no automatic artistic pass and no approval button.

For browser evidence, wait for `window.avatarDraft.ready`, capture the actual
canvas and record `window.avatarDraft.evidence()`. That JSON includes the
viewport, DPR, canvas backing/CSS ratio, camera zoom, logical and CSS avatar
size, live body dimensions, actual texture filter values, PNG hashes,
the shadow recipe and positions, label treatment, and hashes of reused
map/art modules. `setFacing`, `setSurface`, `setZoom` and
`setLineup` on the same object support repeatable inspection without changing
the renderer. Reload after every art export so the hash-bound frame URLs
and pixels refer to the new candidate.

No visual pass has been recorded by building this preview. The producer owns
inspection of the rendered result before any handoff.
