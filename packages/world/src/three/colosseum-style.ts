/**
 * The Colosseum's one set of proportions and stones (D-129).
 *
 * The building on the street (three/colosseum-builder.ts) and the arena
 * inside it (three/arena-room.ts) are two models of the same place, so they
 * read their heights and their masonry from here: the wall a player walks up
 * to outside and the wall they stand under inside top out at the same
 * `COLOSSEUM_WALL_TOP`, and the arcades they see line up band for band.
 *
 * Nothing here is gameplay. Collision, the door and the return tile are the
 * map's (map/colosseum.ts) and never move with these numbers.
 */

/** The base course the arcades stand on. */
export const COLOSSEUM_PLINTH = 0.45;
/** Top of the first arcade, and of the second. */
export const COLOSSEUM_TIER1_TOP = 2.5;
export const COLOSSEUM_TIER2_TOP = 4.5;
/** The blind attic over the arcades, and the cornice that caps the wall. */
export const COLOSSEUM_ATTIC_TOP = 6.0;
export const COLOSSEUM_WALL_TOP = 6.2;

/**
 * Head clearance under the grand arch, over its walkable threshold: the one
 * place the building stands over a tile a player can be on.
 */
export const COLOSSEUM_ARCH_SPRING = 1.9;

/** Warm sandstone, as the arena's travertine is warm. */
export const COLOSSEUM_STONE = Object.freeze({
  wall: 0xc9b188,
  wallDark: 0xa48f6c,
  pier: 0xd6c09a,
  cornice: 0xb09a74,
  plinth: 0x8e7c5f,
  shadow: 0x4a3a2c,
  sand: 0xdcc191,
  sandDark: 0xc2a473,
  iron: 0x3a3532,
});

/** The ember palette (docs/brand/README.md), shared by both models' fire. */
export const COLOSSEUM_EMBER = Object.freeze({
  ember: 0xf56a16,
  gold: 0xffc12e,
  sunTop: 0xffd23a,
  sunBottom: 0xe8501a,
  drop: 0xb8400c,
  outline: 0x24120a,
  cream: 0xfff6e6,
  bannerRed: 0xa8261d,
  navy: 0x23325c,
  bone: 0xe9dfc9,
});
