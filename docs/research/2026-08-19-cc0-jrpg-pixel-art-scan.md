# CC0 16-bit JRPG-style pixel-art bases

**Audited:** 2026-08-19
**Purpose:** quick follow-up scan after the Kenney placeholder discussion. This
is an options note, not an aesthetic selection. “Chrono Trigger-like” here
means a warm, readable 16-bit JRPG treatment with orthogonal top-down tiles; it
does not imply affiliation, copying, or use of any protected game assets.

I checked the creator or original asset listing only. Nothing was downloaded,
retiled, recolored, or added to the repository. Before import, inspect the
archive's own license/credits files and record attribution alongside the
assets, even where attribution is optional.

## Candidates

| Base | First-party evidence | Fit for the requested direction | License / obligations | Read |
|---|---|---|---|---|
| [Kenney RPG Urban Pack](https://kenney.nl/assets/rpg-urban-pack) | Kenney lists a 16×16 2D pack with city, urban, character and pixel tags and 480+ files. | Best practical city placeholder: streets, façades and characters are already urban, but its clean modular language is less handcrafted JRPG than the target. Keep the current 2× rendering path if the world remains 32 px. | CC0; attribution is not required. Courtesy credit to Kenney is still sensible. | **Best immediate scaffold**, not the closest mood match. |
| [ansimuz — Tiny RPG Forest](https://opengameart.org/content/tiny-rpg-forest) | The author/listing describes a complete 16×16 top-down set, objects, a four-direction animated player, enemies, water and a Phaser demo; it is tagged Zelda/Final Fantasy. | **Closest starting language** for warm 16-bit JRPG readability. It is forest/fantasy rather than a city, so protocol façades and streets would need authored additions or a controlled reskin. | CC0/public domain; credit is optional but appreciated. Music in the pack has a separate credit requirement and should not be imported casually. | **Best mood reference/base** if a fantasy-city hybrid is acceptable. |
| [russpuppy — RPG Tileset](https://opengameart.org/content/rpg-tileset) | The original listing is a 16×16 CC0 RPG set tagged with buildings, paths, water, characters, signs and props. | More sparse than Kenney or ansimuz, but its simple orthogonal shapes can support a deliberately chunky 16-bit street grammar and custom protocol buildings. | CC0; the author says attribution is not required, with optional `Russpuppy` and `russpuppy.com` credit. | **Good low-risk style seed**, not a complete city kit. |
| [uheartbeast — Stunning Pixel Art RPG Tileset](https://opengameart.org/content/stunning-pixel-art-rpg-tileset) | The original listing is CC0, tagged RPG/pixel/tileset, and grouped under 16×16 graphics and Pixel Art–JRPG. It supplies grass, paths, water, plants and trees. | Strong palette/treatment reference for the 16-bit feel, but it is a small terrain kit with no city building set or player roster. Use as a visual companion only unless a local inspection confirms enough usable coverage. | CC0; commercial use is explicitly allowed and credit is appreciated, not required. | **Best treatment reference**, not a standalone world base. |

## Conditional / rejected for this pass

| Candidate | Reason |
|---|---|
| [IshtarPixels — cozy asset pack 1.0](https://opengameart.org/content/cozy-asset-pack-10) | The listing says 16×16, top-down, 130+ tiles, characters, commercial use and CC0. However, the page's own comments record a CC-BY3 metadata/archive mismatch that the creator says was edited. Until the archive is checked, it is not a clean public-repo recommendation; its “cozy and cute” language also points away from the stronger JRPG-adventure tone. |
| [yd — Top-down simple tile-sets](https://opengameart.org/content/top-down-simple-tile-sets) | CC0 and tagged as a 32×32 JRPG-ish style, but the page describes templates rather than a finished city/character base. It is useful for palette or tiling experiments, not an import candidate without a separate authored-art pass. |

## Recommendation for the next user choice

Keep Kenney as the functional placeholder so implementation is not blocked.
For the eventual visual direction, compare only these two small paths:

1. **Urban-first:** Kenney streets/buildings plus a custom palette and a small
   JRPG treatment pass. This gets STRKWORLD's protocol-city readability fastest.
2. **JRPG-first:** ansimuz as the mood/character reference, with a deliberately
   authored city layer for the protocol buildings. This is closer to the
   requested 16-bit feeling but requires more original art work.

The russpuppy and uheartbeast sets are useful CC0 ingredients/references, not
reasons to mix four unrelated palettes. The user should choose the direction
before assets are downloaded or committed; then perform an archive-level
license check and a tiny street test map at the project's chosen integer scale.
