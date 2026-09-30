/**
 * The World's lighting as data (D-059): a warm, high sun with soft shadows over
 * a sky-to-ground hemisphere, tone-mapped ACES filmic at unit exposure.
 *
 * Pure numbers, no three.js. The engine builds its lights from these, and the
 * offline render of the Shell's walker (`tools/avatar-walker.ts`) shades with
 * the same values, so the pre-rendered figure cannot drift from the game's
 * light. Colours are sRGB hex, as three.js takes them.
 */

export const SUN_COLOR = 0xffe1b3;
export const SUN_INTENSITY = 2.4;
/** Sun offset from the camera focus: high in the south-west, so facades are lit. */
export const SUN_OFFSET = Object.freeze({ x: -14, y: 24, z: 12 } as const);

export const HEMISPHERE_SKY = 0xcfe3ff;
export const HEMISPHERE_GROUND = 0x5b4a3c;
export const HEMISPHERE_INTENSITY = 1.0;

/** Half the side of the sun's square shadow frustum, in world units. */
export const SHADOW_EXTENT = 22;
export const SHADOW_MAP_SIZE = 2048;
/** World units per shadow texel; the light moves in whole texels so edges hold still. */
export const SHADOW_TEXEL = (SHADOW_EXTENT * 2) / SHADOW_MAP_SIZE;
/** PCF radius in texels. PCFSoftShadowMap was removed in r186; PCF with a radius softens edges. */
export const SHADOW_RADIUS = 2;
export const SHADOW_NORMAL_BIAS = 0.03;
export const SHADOW_NEAR = 1;
export const SHADOW_FAR = 80;

export const TONE_MAPPING_EXPOSURE = 1.0;
