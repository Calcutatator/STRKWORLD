# Internal construction provenance

These studies were generated with the built-in Codex ImageGen tool, not an API
fallback. They are not approved concept art or final runtime assets. The final
sprites were constructed as editable pixel-aligned Blender/SVG geometry, with
explicit palette mapping and recorded grid edits.

`front-pixel-v1.png`: source generated image `exec-af0e3707-a601-4bb1-a72c-274eb91750e8.png`,
thread `01a094c9-fd48-7940-871a-4e68ac52a933`, SHA256
`a33f29c982065aea3528d201be566e73db0c8a77786c6a171206db4671d0c4d0`.

Prompt:

> Create ONE FRONT-FACING IDLE GAME SPRITE construction study. Image 1 is the binding pixel-art STYLE, medium proportions, shape language and game viewpoint reference. Image 2 is ONLY character identity and clothing design. Translate this character into a polished, warm 16-bit JRPG overworld pixel sprite like the FRONT character in image 1. Match image 1's large expressive head and slender compact body, circa 3.5-4 head heights INCLUDING spiky hair. Slightly elevated top-down game view showing crown, tops of shoulders and boots. Genuine low-resolution pixel art with clean deliberate square pixel clusters, hard one-pixel dark selective contour, about 24-32 warm colors, 3 shades per material. Target a 64x64 sprite cell with figure about 49 pixels tall from y7 to55, approximately24 pixels wide excluding scarf. Show enlarged at exact nearest-neighbor 16x, whole 1024x1024 image = 64x64 deliberate square-grid pixels. No fine detail smaller than one grid square, no smooth curves, no soft shaded anime illustration, no anti-aliasing, no painting texture. Calm alert friendly eyes using tiny simple dark pixel clusters. Copper/chestnut swept spiky hair, warm skin, teal scarf wrapping neck and two modest tails to his LEFT (viewer right), dark petrol sleeveless tunic with diagonal brown chest harness, brown waist belt with small brass buckle, single brown flap pouch on his RIGHT hip (viewer left), charcoal trousers, brown fingerless gloves/bracers, rolled cuff brown boots. Preserve slim articulated legs and visible bare upper arms. Front neutral idle facing camera straight, subtle natural asymmetric cloth, both feet grounded on one baseline. No weapons, no cape, no oversized pauldrons. Isolated on flat light cream background #f4ecd8, no shadow, no text or labels, no checkerboard, no extra figures or panels. This is a real sprite production study, not concept art presentation.

The output was 1254×1254 with real alpha; it did not follow the requested exact
output resolution or native pixel grid. Registration therefore uses explicit
source bounds and a 50px target in `source/construct_grid.py`. Approximate head
ratios in the generation prompt are not a user-approved specification; actual
original-reference comparison governs the accepted sprite proportions.

`turnaround-pixel-v1.png`: source generated image `exec-e03bee63-e449-4f60-be31-b815d251b5f5.png`,
worker thread `01a0a5c1-a638-72a0-a2c3-932bb3ffac8f`, SHA256
`d90c0c5969d3c2057b9403d586e03d14024724858ecdd1c5ce856b15725ca860`.

Prompt:

> Use case: stylized-concept.
> Asset type: ONE internal pixel-sprite turnaround construction image for the original STRKWORLD avatar.
> Primary request: extend reference image 1 into exactly THREE matching directional idle views arranged horizontally: LEFT profile facing toward the left edge, RIGHT profile facing toward the right edge, BACK facing fully away. No front-facing view.
> Reference roles: image 1 is the immediate authoritative front pixel-sprite model, colour and cluster style to match. Image 2 establishes the approved medium JRPG sprite proportions and slightly elevated game-view vocabulary. Image 3 establishes costume details and original character identity ONLY, not its illustrated rendering or adult body proportions.
> Style: warm late-16-bit JRPG pixel art. Deliberately authored chunky pixel clusters, crisp stepped dark contours, restrained coherent shading. Think of a native 64x64 cell with a 50-pixel-tall character enlarged by an integer factor. Preserve the front sprite's expressive hair-inclusive head at about17px of50px height, slender medium torso, waist, articulated legs and cuffed boots. The same medium character in every view: never squat/chibi, never six-head adult anime figure.
> Character: tousled swept spiky copper/chestnut brown hair, warm skin, simple friendly face in profile with one stable readable eye, dark petrol sleeveless tunic with short diagonal hem, charcoal trousers, brown fingerless gloves/bracers, brown rolled-cuff boots, brown harness with modest gold fittings.
> Costume continuity: the teal scarf wraps the neck and has exactly TWO tails attached at the character's anatomical LEFT shoulder in every view. The SINGLE brown flap pouch is on anatomical RIGHT hip: largely occluded in LEFT profile, clearly visible on the near hip in RIGHT profile, visible on viewer-RIGHT in BACK view. In BACK view the brown harness is an X and the two scarf tails hang toward viewer-LEFT. Do not mirror the pouch or attach scarf to the other shoulder.
> Viewpoint/pose: slightly elevated top-down game camera, visible crown and top of shoulders and boot toe caps, calm natural standing idle with both feet grounded. Both profiles are actual side views of the same body, neither is a three-quarter front pose. Do not cross the limbs or duplicate hands.
> Composition: exactly three separate full-body figures, equal height, same feet baseline, generously and equally spaced across a wide landscape image. Keep all hair tips, scarf ends and boots fully within each figure's own third of the image.
> Background: genuine transparent alpha, completely empty; no black or white background painted into the image, no checkerboard, no ground plane or shadow.
> No text, labels, frame borders, front figure, additional characters, weapons, animation poses, perspective floor, gradients, smooth illustration, individual hair-strand noise or realistic muscle detailing. This is a pixel-sprite construction study, not a poster or character illustration.

The output reordered the views as LEFT / BACK / RIGHT. Registration follows
the observed facings, not the requested order. Faint alpha ghosts are excluded
when sampling the source studies. The final SVG rasterizer applies no alpha
threshold: authored grid geometry renders directly to binary-alpha PNGs.

The first direct grid conversion lost the front eye clusters. The producer
inspected the actual grid and rebuilt the two simple eyes, face planes and
scarf edge in `source/refine_grid.py`. The final grid records every changed
cell. Both original and revised construction output were inspected before
native export, and the exact exports were inspected again in actual Phaser.

`*-grid-8x.png` records the initial sampled grid before deliberate face edits.
`*-light-8x.png` and `four-grids-4x.png` show the refined construction.
The authoritative rendered outputs remain `frames/{direction}/idle.png`.
