# Top-down city / pixel-art asset options

**Audited:** 2026-08-19  
**Scope:** candidate art packs for STRKWORLD's orthogonal Phaser world, where
the current authored map uses a roughly 32 px world tile.  No pack was
downloaded, inspected locally, or added to the repository.  This is an options
audit, not an aesthetic selection.

## Method and license boundary

I checked only the creator's own page or the original marketplace listing that
hosts the creator's listing.  The page's stated license is the evidence for
this shortlist; a future asset import still needs an archive-level license
check and a small attribution record committed with the files.

For a public repository, the cleanest fit is CC0. The [CC0 1.0 legal deed](https://creativecommons.org/publicdomain/zero/1.0/)
is intended to waive copyright-related restrictions, while any creator request
for attribution should still be honored in `docs/research` or an asset
credits file. A commercial game license that forbids redistribution is not a
license to commit the source pack to a public repository; it can only be a
private, uncommitted art dependency unless the creator gives written permission
for repository redistribution.

## Shortlist

| Option | What the first-party page confirms | 32 px / world fit | Public-repo license read | Recommendation |
|---|---|---|---|---|
| [Kenney RPG Urban Pack](https://kenney.nl/assets/rpg-urban-pack) | 2D, city/urban/character/pixel tags; 16×16 tiles; 480 files; CC0. | Strong source of city pieces and characters, but it is half-scale for the current 32 px map. Use integer 2× rendering or a deliberate 16 px world grid; do not mix arbitrary resampling. | CC0; no attribution required by the page. Credit `Kenney.nl` anyway. | **Best low-risk starting point** if its visual language suits the city. |
| [FisherG — (12×12) City Tiles](https://opengameart.org/content/12x12-city-tiles-top-down) | Top-down 12×12 pack with streets, sidewalks, signs, customizable buildings/houses, grass, trees, vehicles, and NPC/player concepts; CC0. | Most complete literal street/grass/building/player brief, but 12 px is not a clean 32 px fit. It needs a 2×/3× presentation decision or retiled map rather than direct insertion. | CC0. Attribution is optional; creator asks for `FisherG` plus an OGA-profile or Twitter link. | **Best compact-city prototype** if the team accepts a smaller-grid look. |
| [ansimuz — RPG Town Pixel Art Assets](https://opengameart.org/content/rpg-town-pixel-art-assets) | Top-down 16×16 pixel-art town; four-way roads, customizable building, trees, river/pond, dirt and props; CC0. | Good orthogonal town grammar and integer 2× scale. It reads as SNES/fantasy rather than modern urban; roads/buildings are useful, but a player sprite and modern protocol facades would need a matching treatment. | CC0; the page gives no required credit. Keep `ansimuz` in credits as courtesy. | **Best coherent retro-town base** for an intentionally stylized city. |
| [isaiah658's Pixel Pack #1](https://opengameart.org/content/isaiah658s-pixel-pack-1) | Designed for a 16×16 tile game; nine buildings, 13 characters, cars, grass, flowers, roads and sidewalks; CC0. | Strongest documented coverage of buildings, roads, grass and player sprites. It includes some objects accidentally sized 64×64, so import needs an object-size audit and selective use. Integer 2× is possible. | CC0; credit `isaiah658` is explicitly optional but appreciated. The author also asks that derivatives be CC0, which should be followed if this becomes the base. | **Best functional coverage**; likely the fastest route to a playable prototype, subject to a consistency pass. |

These four are candidates for a user-facing visual comparison. The pages do
not establish that the packs share one palette or that any one pack contains
the exact STRKWORLD building silhouettes. That requires a later visual review
and a small test map, after the user chooses a direction.

## Rejected or conditional candidates

These are useful references but are not safe recommendations for importing into
the public STRKWORLD repository under the terms currently visible on their
first-party pages.

| Candidate | Why it is not in the recommended set |
|---|---|
| [BloodyFish — Pixel Streets](https://bloodyfish.itch.io/pixel-streets) | The page documents useful 16×16 roads, sidewalks, crossings, signs and vehicles, and says CC0, but also says “reselling not allowed.” That conflicts with an unqualified public-repository redistribution of the pack. The page is also marked **In development** and does not document the requested buildings/grass/player set. Do not import until the creator clarifies whether public source redistribution is permitted. |
| [MikAnimus — TopDown City 32×32](https://mikanimus.itch.io/city) | Technically the closest grid match: 32×32 sprite sheet, top-down pixel-art city. The creator expressly forbids redistribution and explicitly forbids “NFT/crypto/play to earn projects,” so it is incompatible with STRKWORLD's public crypto game even if purchased. |
| [Dlou Saiyan — Urban City Tileset Ultimate](https://dlou-saiyan.itch.io/urban-city-tileset-32-32-2d-pixel-art-street-environment) | Strong 32×32 road, sidewalk, façade, building and prop coverage, with a prototype character. However, the commercial terms forbid reselling or redistributing the pack, require credit to Dlou Saiyan, and therefore do not permit committing the source assets to this public repository. It could only be evaluated as a private, uncommitted dependency after purchase and explicit repository policy approval. |
| [KodaMonroezz_Games — Modern Town](https://amadeva.itch.io/modern-town-top-down-pixel-art-game-kit) | Cohesive modern top-down city kit with map, scenes, characters and vehicles; however, the page says these are finished background images rather than paintable tile grids, and forbids redistribution as an asset pack. Its license is therefore unsuitable for public-repo inclusion. The page also discloses AI-assisted text/content, which would need a separate provenance review. |
| [devurandom — 8-bit city tile set](https://opengameart.org/content/8-bit-city-tile-set) | CC0 and clearly city/road/building themed, but the listing tags it as a side-scroller and describes an irregular sheet rather than an orthogonal top-down tile system. Keep as a visual reference only until a local inspection proves it can support the World map without forcing a perspective mismatch. |

## User choice gate

No pack should be selected or downloaded yet. The practical next choice is
between these directions:

1. **Kenney urban** — broad 16×16 CC0 library, then build the city at 16 px or
   render it at a clean 2× scale.
2. **FisherG compact city** — the most literal streets/grass/buildings/player
   prototype, accepting a 12 px grid treatment.
3. **ansimuz retro town** — cohesive SNES-like town language, adapted into
   protocol buildings.
4. **isaiah658 functional pack** — broadest documented gameplay coverage,
   with a cleanup pass for inconsistent object sizes.

The user should choose the visual direction before any asset is downloaded,
retiled, recolored, or committed. After that choice, verify the archive's
embedded license/credits, make a tiny street test map using the existing World
collision conventions, and record exact attribution before landing files.
