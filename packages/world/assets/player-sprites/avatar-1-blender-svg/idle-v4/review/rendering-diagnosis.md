# Why idle-v4 cannot establish in-game quality

Verified 2026-09-13 from the isolated checkout and current local listener state.
This is a rendering diagnosis, not a new artistic pass or approved direction.

The draft has never been integrated or rendered inside the game. Runtime URLs
in `packages/world/src/avatar-visual.ts` still point to `assets/player-sprites/v1`.
No server currently listens on localhost:5173. The review boards show exported
PNG pixels on plain backgrounds; they are not screenshots of the running game.

The current avatar frame is 64×64 world units, with feet `(32,56)` and a 24×24
Arcade body. `createCamera()` in `scenes/street-scene.ts` sets zoom 2. At scale 1,
a 64-pixel frame therefore occupies 128 CSS pixels; a 52-pixel-tall figure
occupies approximately 104 CSS pixels. `runtime.ts` enables `pixelArt: true`,
which selects nearest filtering. Retina display density does not restore
missing source detail. Installed Phaser's RESIZE implementation sizes the
backing canvas from the parent dimensions without a project DPR multiplier.

Idle-v4's SVG contains real editable vector paths, but those paths were
reconstructed from a 64×64 colour-index design. Increasing the SVG output
resolution only enlarges those block-shaped boundaries. It does not restore
the approved illustration's facial drawing, contours or shading. The native
Blender/SVG technical checks accurately establish source/export consistency;
they cannot establish the intended artistic result.

Resolution is a constraint, not an excuse for poor pixel art. A deliberate
52-pixel character can be well drawn. The unresolved choice is whether the
user intends a crisp illustrated translation of the approved concept or a
purposefully low-resolution pixel-art interpretation. The producing agent
asked that explicit style question after withdrawing idle-v4, and must not
claim an answer or a new approved rendering direction from silence.

For a crisp illustrated direction, an isolated proof can use genuinely
higher-detail source artwork at 128×128 frame resolution, sprite scale 0.5,
and the same normalized origin. That keeps the frame at 64×64 world units.
Arcade body setup must account for source density: a 48×48 source body at
(40,88) becomes the existing 24×24 world body at the same feet position.
Per-texture filtering can be selected without changing the tilemap's nearest
filtering. Smooth edges require an explicit amendment to the current binary
alpha policy. Actual production integration would need consistent density
handling for local, remote and Studio avatars; no runtime change is made or
approved by this diagnosis.

For deliberate pixel art, preserve the current runtime geometry and create
controlled pixel clusters at the target resolution. Neither a finely detailed
ImageGen picture reduced to 64 pixels nor a raster traced into SVG is a
substitute for that drawing work. Inspect actual game-size art against the
approved character, then validate it in its intended rendering context before
claiming in-game quality.

The concept-v2 approval remains valid. Idle-v4 is unapproved and withdrawn.
