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

/** The base course the arcade stands on. */
export const COLOSSEUM_PLINTH = 0.45;
/**
 * Top of the arcade: one storey of arches, not two (amended 2026-10-03). The
 * middle storey came off because the building stood over the street's own
 * buildings and hid them; the ground arcade and the attic above it are the
 * two floors that are left, and the ground arcade is exactly what it was.
 */
export const COLOSSEUM_ARCADE_TOP = 2.5;
/**
 * The blind attic over the arcade, and the cornice that caps the wall.
 *
 * The attic is the taller of the two floors now: the arena room's own arcade
 * (`ARENA_SURFACE.arcade`, with its banners hung above the top tier) sets how
 * low this pair of numbers can go before the room's attic colonnade stops
 * being a colonnade. So the wall came down by less than the storey that came
 * off it (1.4 of 6.2, not 2.0), and the attic took up the difference.
 */
export const COLOSSEUM_ATTIC_TOP = 4.6;
export const COLOSSEUM_WALL_TOP = 4.8;

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
