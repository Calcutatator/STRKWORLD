import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  NormalBlending,
  PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import type { ColorRepresentation, Material, Object3D, Texture } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BuildingId, StationId } from '@strkworld/shared';
import type { FixedRoomLevelId } from '../fixed-room.js';
import type { FloatingStyleOptions, SignStyleOptions } from './labels.js';
import type { Occluder, OccluderBounds } from './types.js';

/**
 * Colours, material specs and the small low-poly kit shared by the 3D
 * environment builders — street, fixed rooms, the Avatar Studio and the block
 * sandbox (D-059, D-060).
 *
 * Everything here is presentation. One palette keeps a building's facade, its
 * sign and its interior reading as one place — including the two brand refits,
 * whose measured hexes live only here; one kit means every builder merges
 * geometry per material, fades occluders and disposes GPU resources the same
 * way, which is what keeps the street under its draw-call budget.
 */

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** Golden-hour street colours. Slightly desaturated: the key light is warm. */
export const PALETTE = Object.freeze({
  grassWarm: 0x86ad55,
  grassCool: 0x5f9150,
  asphalt: 0x51525c,
  paint: 0xf4f0e4,
  paintCentre: 0xf2cf6b,
  sidewalk: 0xc4bdb1,
  sidewalkAlt: 0xbab3a7,
  kerb: 0xa39c91,
  tactile: 0xd8b24a,
  pathStone: 0xd6c9ab,
  apron: 0xb1aa9e,
  hedge: 0x3f7a3f,
  hedgeLight: 0x4f8b47,
  trunk: 0x6e4b33,
  canopies: Object.freeze([0x4f8f41, 0x5f9d46, 0x6ea94c, 0x86a843, 0xd08b3e]),
  pines: Object.freeze([0x3e7449, 0x4a8150, 0x3a6b47]),
  flowers: Object.freeze([0xf48fb1, 0xffd166, 0xfffaf0, 0xb39ddb, 0xff8a65]),
  leaf: 0x4c7d3a,
  tuft: 0x5b8c42,
  hills: Object.freeze([0x7fa85a, 0x8cb363, 0x6f9c55, 0x93b56c]),
  lampPost: 0x2e3338,
  lampGlow: 0xffd28a,
  barrierRed: 0xd0503f,
  barrierWhite: 0xf5f1e8,
  fairyLight: 0xfff0b8,
  backdrop: Object.freeze([0xd8c7ae, 0xc9b596, 0xb9c3c9, 0xd3bfc9, 0xc4ccb4, 0xe0d2bc]),
  backdropRoof: 0x8e7f70,
  backdropWindow: 0xffd59a,
  backdropWindowDark: 0x5b6470,
});

// ---------------------------------------------------------------------------
// Brand palettes: measured from the live apps, and the only place these live
// ---------------------------------------------------------------------------

/** The Exchange's swap route, avnu — measured from app.avnu.fi. */
export const AVNU = Object.freeze({
  navy: 0x11131d,
  card: 0x1b1e2d,
  indigo: 0x1c204a,
  indigoBorder: 0x313881,
  blue: 0x3761f6,
  lightBlue: 0x718ef9,
  slate: 0x7c8298,
  white: 0xffffff,
});

/** The Bank's shielding pool, STRK20 — measured from strk20.starknet.io. */
export const STRK20 = Object.freeze({
  black: 0x0d0d0d,
  surface: 0x141414,
  raised: 0x1a1a1a,
  hairline: 0x262626,
  text: 0xfafafa,
  orange: 0xc53400,
  orangePressed: 0xa02a00,
  /** Alpha of the accent's glow, `rgba(197,52,0,0.55)`. */
  glowAlpha: 0.55,
  /** The heading gradient, top to bottom. */
  cream: 0xfffdf1,
  blush: 0xf4ece8,
  peach: 0xffcdb6,
});

/**
 * The Bridge's deposit route, NEAR Intents — measured from near.org /
 * intents.near.org. A black and white base with one green accent. The
 * Intents orange is left out on purpose: the Bank owns orange.
 */
export const NEAR = Object.freeze({
  black: 0x000000,
  surface: 0x0a0a0a,
  raised: 0x171717,
  elevated: 0x1e1e1e,
  elevatedAlt: 0x242424,
  hairline: 0x2a2a2a,
  white: 0xffffff,
  muted: 0x9ca3af,
  /** The primary accent; anything printed on it is black. */
  green: 0x00ec97,
  greenTint: 0xc7f5d8,
  /** Sparingly. */
  teal: 0x17d9d4,
  periwinkle: 0x9797ff,
  /** A hint, and only ever as glow. */
  violet: 0xa855f7,
  /** Pending and processing. */
  amber: 0xfbbf24,
});

/**
 * The Bank's staking counter, Endur (D-063) — measured from app.endur.fi /
 * endur.fi. A light brand, unlike the others: mint-white and white surfaces,
 * dark green bands and trim, one muted green accent. Its green shares NEAR's
 * hue, so it stays light and muted, never neon on black.
 */
export const ENDUR = Object.freeze({
  base: 0xe8f7f4,
  card: 0xffffff,
  band: 0xedf5f2,
  bandAlt: 0xf0f7f5,
  /** Dark bands, trim and text on light. */
  dark: 0x0d1a17,
  ink: 0x09090b,
  /** The primary accent; text on it is dark, never white. */
  green: 0x2db882,
  greenDeep: 0x17876d,
  greenDeeper: 0x03624c,
  /** BTC orange: sparingly, or not at all. */
  btc: 0xd97706,
  border: 0xe4e4e7,
  borderAlt: 0xececed,
});

/**
 * The Vault's future lender, Vesu — measured from vesu.xyz (Sept 2026): white
 * pages, near-black text in a wide grotesk at 600, an electric-blue primary
 * and a pale periwinkle secondary with deep-blue text.
 */
export const VESU = Object.freeze({
  white: 0xffffff,
  ink: 0x0a0a0a,
  blue: 0x2c41f6,
  blueSoft: 0xe0e5ff,
  blueText: 0x2030b6,
});

/**
 * The Exchange tower's Degen floor (its first floor): neon over avnu's own
 * navy and indigo. The walls stay avnu's; these are the accents that make it
 * loud. Not a brand: nobody's palette is claimed here.
 */
export const DEGEN = Object.freeze({
  pink: 0xff3dbb,
  pinkDeep: 0x9c1f73,
  lime: 0xb8ff3d,
  cyan: 0x3de8ff,
  violet: 0x9b5cff,
  yellow: 0xffd23d,
  ink: 0x0b0c14,
});

/** The stand-in mark a poster shows until its art is decoded, or if it never is. */
export type DegenMotif = 'crown' | 'stars' | 'blade' | 'coin' | 'gem' | 'bolt';

/**
 * One Degen-floor poster. Presentation vocabulary only: a ticker, a name,
 * colours, a stand-in motif and the poster's art. The World must not know
 * what money is (AGENTS.md §4), so a poster never carries a price, an amount,
 * an arrow, a chart or an address, and the degen swap's real token list is
 * the Shell's.
 */
export interface DegenToken {
  readonly ticker: string;
  readonly name: string;
  readonly colors: {
    /** The stand-in poster's colour block. */
    readonly background: number;
    /** The neon frame round the poster, and the stand-in's motif and name. */
    readonly accent: number;
    /** The stand-in's ticker type. */
    readonly ink: number;
  };
  readonly motif: DegenMotif;
  /**
   * The poster's art: a bundled 512 by 768 WebP composed from the project's
   * own logo and imagery (sources in `assets/CREDITS.md`). A URL the bundler
   * resolves to the game's own origin; never a third-party address.
   */
  readonly poster: string;
  /** A slot still waiting for the lead's research. */
  readonly placeholder?: boolean;
}

/**
 * A bundled poster. `new URL` with `import.meta.url` is what Vite rewrites to
 * the emitted asset (as `avatar-visual.ts` does for the avatar sheets), so the
 * browser fetches it from the game's own origin, and node tests read the file.
 */
function degenPosterAsset(file: string): string {
  return new URL(`../../assets/degen-posters/${file}.webp`, import.meta.url).href;
}

/**
 * The Degen floor's posters, one per entry and drawn in this order (north
 * wall first, see room-builder.ts). Tickers and projects come from avnu's
 * public token list (Community / Unruggable / Verified tags, read 2026-09-27).
 * Each poster is composed from its project's own logo, art, colours and type
 * (read from avnu's token API and the project's site, 2026-09-28); the
 * colours here are measured from those assets and dress the neon frame and
 * the stand-in. Decoration only: no price, chart or address ever appears on
 * a poster, and a poster is not a swap listing. Up to eight fit the walls.
 */
export const DEGEN_TOKENS: readonly DegenToken[] = Object.freeze([
  Object.freeze({
    ticker: 'LORDS',
    name: 'Realms',
    // Realms World: night-blue key art, gold type, the badge's cream.
    colors: Object.freeze({ background: 0x07080c, accent: 0xd8b46a, ink: 0xfbe1bb }),
    motif: 'crown',
    poster: degenPosterAsset('lords'),
  }),
  Object.freeze({
    ticker: 'DREAMS',
    name: 'Daydreams',
    // The brain mark's yellow on daydreams.systems' dark olive and cream.
    colors: Object.freeze({ background: 0x0b0d04, accent: 0xe8e84d, ink: 0xf4f5de }),
    motif: 'stars',
    poster: degenPosterAsset('dreams'),
  }),
  Object.freeze({
    ticker: 'SLAY',
    name: 'Brother Eli',
    // brothereli.com's cut-out yellow and torn paper on black.
    colors: Object.freeze({ background: 0x050505, accent: 0xfcd809, ink: 0xefe6d4 }),
    motif: 'blade',
    poster: degenPosterAsset('slay'),
  }),
  Object.freeze({
    ticker: 'BROTHER',
    name: 'Starknet Brother',
    // supbro.fun's navy and the mascot's coral helmet.
    colors: Object.freeze({ background: 0x0c0c61, accent: 0xf07c6c, ink: 0xffffff }),
    motif: 'bolt',
    poster: degenPosterAsset('brother'),
  }),
  Object.freeze({
    ticker: 'tBTC',
    name: 'Threshold',
    // threshold.network: a light page, Threshold violet, black tBTC coins.
    colors: Object.freeze({ background: 0xf2f3f7, accent: 0x7d00ff, ink: 0x0b0b0f }),
    motif: 'coin',
    poster: degenPosterAsset('tbtc'),
  }),
  Object.freeze({
    ticker: 'CASH',
    name: 'Opus',
    // opus.money's black and white, and the CASH coin's green.
    colors: Object.freeze({ background: 0x050505, accent: 0x66cc88, ink: 0xffffff }),
    motif: 'gem',
    poster: degenPosterAsset('cash'),
  }),
  Object.freeze({
    ticker: 'DOG',
    name: 'Dog Go To The Moon',
    // The DOG art's space purple and the hoodie's bitcoin orange.
    colors: Object.freeze({ background: 0x3f3268, accent: 0xf7931a, ink: 0xffffff }),
    motif: 'coin',
    poster: degenPosterAsset('dog'),
  }),
  Object.freeze({
    ticker: 'SSTR',
    name: 'Sister',
    // The Sister avatar: pale pink, coral ring, violet hair.
    colors: Object.freeze({ background: 0xffe9e9, accent: 0xf19891, ink: 0x6661d9 }),
    motif: 'stars',
    poster: degenPosterAsset('sstr'),
  }),
] satisfies readonly DegenToken[]);

/** A palette number as CSS, so canvas labels read the same source. */
export function css(hex: number): string {
  return `#${(hex & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function cssAlpha(hex: number, alpha: number): string {
  return `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${alpha})`;
}

/**
 * A brand colour lifted in sRGB lightness for a lit 3D surface. Near-black UI
 * colours render as a hole under a warm key light and ACES; lifting keeps the
 * hue and the dark character while letting form read. Self-lit surfaces
 * (screens, light strips, signs) use the measured colours unlifted.
 */
export function lift(hex: number, lightness: number): number {
  const colour = new Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  colour.getHSL(hsl, SRGBColorSpace);
  colour.setHSL(hsl.h, hsl.s, clamp01(hsl.l + lightness), SRGBColorSpace);
  return colour.getHex(SRGBColorSpace);
}

export function mixHex(a: number, b: number, t: number): number {
  return mixColor(a, b, t).getHex(SRGBColorSpace);
}

/** The block sandbox (D-060): a warm concrete build plate and toy blocks. */
export const SANDBOX_THEME = Object.freeze({
  plate: 0xdccfb9,
  grid: 0xc6b8a0,
  border: 0x9f907a,
  /** The entrance apron inside the gate, kept clear of sky drops: the plate, a shade lighter. */
  entrance: 0xe6dcc9,
  /** Index = `SandboxColumn` colour. Saturated enough to survive warm light. */
  blocks: Object.freeze([0xe4524b, 0xf28f3b, 0xf5cf4f, 0x5dbb63, 0x35b3b0, 0x4a78d8, 0x9467d0, 0xf2efe6]),
  targetValid: 0xfff1c4,
  targetInvalid: 0xff4a3d,
  post: 0x4a4038,
  sign: Object.freeze({
    width: 4.2,
    height: 1.1,
    background: '#fff6e3',
    foreground: '#3b2a14',
    accent: '#4a78d8',
    cornerRadius: 0.22,
    borderWidth: 0.05,
  } satisfies SignStyleOptions),
});

/** A facade sign: board size, CSS colours and the optional type treatment. */
export type SignStyle = SignStyleOptions;

/** A protocol's name, set in its own colours, case and weight on a plate: never its logo mark. */
export interface BrandPlate {
  readonly text: string;
  readonly style: SignStyleOptions;
}

export type BuildingStyle = 'bank' | 'exchange' | 'post-office' | 'bridge' | 'vault' | 'generic';

/** Everything a street facade needs to look like its building. */
export interface BuildingTheme {
  readonly style: BuildingStyle;
  /** Height of the main mass; roofs, domes and trusses rise above it. */
  readonly height: number;
  readonly wall: number;
  readonly wallAlt: number;
  readonly trim: number;
  readonly accent: number;
  readonly roof: number;
  readonly door: number;
  readonly windowLit: number;
  readonly windowGlow: number;
  readonly windowDark: number;
  /** Sconces, emblems, light strips and other small emissive details. */
  readonly glow: number;
  /** Emissive strength of `glow`; light strips want more than lanterns. */
  readonly glowIntensity?: number;
  /** Blinking roof lights. */
  readonly beacon: number;
  /** Share of windows that are lit, 0..1. */
  readonly litRatio: number;
  /** Door portal glow; the Vault's is a dim locked red. */
  readonly portal: number;
  /** Emissive strength of an open portal's frame (1.8); bright accents want less. */
  readonly portalIntensity?: number;
  readonly sign: SignStyle;
  /** The protocol behind the building, named on a plate beside its sign. */
  readonly brand?: BrandPlate;
}

export const BUILDING_THEMES: Readonly<Record<BuildingId, BuildingTheme>> = Object.freeze({
  bank: Object.freeze({
    style: 'bank',
    height: 4.4,
    // STRK20: near-black stone, lifted just enough that its colonnade reads,
    // lit only by the one burnt-orange accent.
    wall: lift(STRK20.raised, 0.1),
    wallAlt: lift(STRK20.surface, 0.06),
    trim: lift(STRK20.hairline, 0.13),
    accent: STRK20.orange,
    roof: lift(STRK20.surface, 0.04),
    door: lift(STRK20.surface, 0.05),
    windowLit: STRK20.blush,
    windowGlow: mixHex(STRK20.peach, STRK20.orange, 0.35),
    windowDark: lift(STRK20.black, 0.05),
    glow: STRK20.orange,
    glowIntensity: 2.2,
    beacon: STRK20.orange,
    litRatio: 0.7,
    portal: STRK20.orange,
    sign: Object.freeze({
      width: 2.1,
      height: 0.8,
      background: css(STRK20.surface),
      foreground: css(STRK20.text),
      accent: css(STRK20.hairline),
      gradient: Object.freeze([css(STRK20.cream), css(STRK20.blush), css(STRK20.peach)]),
      cornerRadius: 0.04,
      borderWidth: 0.03,
      hairline: false,
      titleFont: 'display',
      titleTracking: -0.03,
      subtitleFont: 'mono',
      subtitleTracking: 0.12,
      subtitleColor: css(STRK20.peach),
      uppercase: true,
    }),
    brand: Object.freeze({
      text: 'STRK20',
      style: Object.freeze({
        width: 1.8,
        height: 0.42,
        background: css(STRK20.black),
        foreground: css(STRK20.text),
        accent: css(STRK20.orange),
        gradient: Object.freeze([css(STRK20.cream), css(STRK20.blush), css(STRK20.peach)]),
        cornerRadius: 0.06,
        borderWidth: 0.05,
        hairline: false,
        titleFont: 'display',
        titleWeight: 900,
        titleTracking: 0.02,
        uppercase: true,
      }),
    }),
  }),
  exchange: Object.freeze({
    style: 'exchange',
    height: 5.6,
    // avnu: indigo glass (lifted from #1c204a so it reads as glass rather than
    // a hole), slate floor bands, blue light panels.
    wall: lift(AVNU.indigo, 0.08),
    wallAlt: lift(AVNU.navy, 0.06),
    trim: AVNU.slate,
    accent: AVNU.blue,
    roof: lift(AVNU.card, 0.06),
    door: AVNU.card,
    windowLit: AVNU.lightBlue,
    windowGlow: AVNU.blue,
    windowDark: AVNU.indigo,
    glow: AVNU.lightBlue,
    beacon: AVNU.blue,
    litRatio: 0.5,
    portal: AVNU.blue,
    sign: Object.freeze({
      width: 2.9,
      height: 0.78,
      background: css(AVNU.card),
      foreground: css(AVNU.white),
      accent: css(AVNU.indigoBorder),
      // avnu's 32 px card radius, at the board's scale.
      cornerRadius: 0.3,
      borderWidth: 0.035,
      hairline: false,
      titleFont: 'sans',
      subtitleFont: 'sans',
      subtitleColor: css(AVNU.lightBlue),
    }),
    brand: Object.freeze({
      text: 'avnu',
      style: Object.freeze({
        width: 1.5,
        height: 0.5,
        background: css(AVNU.navy),
        foreground: css(AVNU.white),
        accent: css(AVNU.blue),
        cornerRadius: 0.3,
        borderWidth: 0.05,
        hairline: false,
        titleFont: 'sans',
        titleWeight: 800,
        titleTracking: -0.04,
        lowercase: true,
      }),
    }),
  }),
  'post-office': Object.freeze({
    style: 'post-office',
    height: 3.7,
    wall: 0xb4553e,
    wallAlt: 0x974432,
    trim: 0xf3ead6,
    accent: 0x2f5fa3,
    roof: 0x4b5b77,
    door: 0x2f5fa3,
    windowLit: 0xffe0a0,
    windowGlow: 0xffb95c,
    windowDark: 0x34414f,
    glow: 0xffd08a,
    beacon: 0xffd08a,
    litRatio: 0.6,
    portal: 0xffc070,
    sign: Object.freeze({
      width: 2.4,
      height: 0.66,
      background: '#2f5fa3',
      foreground: '#fff7e6',
      accent: '#e8553d',
    }),
  }),
  bridge: Object.freeze({
    style: 'bridge',
    height: 4.4,
    // NEAR: black glass (lifted from #171717 so it reads as glass rather than
    // a hole) in a thin grey frame, dark steel for the span, and green as the
    // one colour, only ever self-lit.
    wall: lift(NEAR.raised, 0.07),
    wallAlt: lift(NEAR.elevated, 0.1),
    trim: lift(NEAR.muted, 0.04),
    accent: NEAR.green,
    roof: lift(NEAR.surface, 0.07),
    door: lift(NEAR.raised, 0.06),
    // Cool, soft interior light, darker than it looks (the mix is linear, and
    // the facade takes the key light): the green stays the only colour.
    windowLit: mixHex(NEAR.greenTint, NEAR.black, 0.85),
    windowGlow: mixHex(NEAR.greenTint, NEAR.black, 0.86),
    windowDark: lift(NEAR.black, 0.05),
    glow: NEAR.green,
    // Light lines are painted near-black and glow green. ACES bleaches a
    // bright green to mint (at 1.0 the measured green comes out #82deb0), so
    // the glow stays low enough to keep the hue.
    glowIntensity: 0.6,
    beacon: NEAR.green,
    litRatio: 0.35,
    portal: NEAR.green,
    portalIntensity: 0.6,
    sign: Object.freeze({
      width: 2.6,
      height: 0.72,
      background: css(NEAR.black),
      foreground: css(NEAR.white),
      accent: css(NEAR.hairline),
      // NEAR's tight 2-8 px radii, at the board's scale.
      cornerRadius: 0.06,
      borderWidth: 0.03,
      hairline: false,
      titleFont: 'sans',
      titleTracking: 0.02,
      // The Intents call to action: uppercase mono, widely tracked, in green.
      subtitleFont: 'mono',
      subtitleTracking: 0.24,
      subtitleColor: css(NEAR.green),
      uppercase: true,
    }),
    brand: Object.freeze({
      text: 'NEAR\nINTENTS',
      style: Object.freeze({
        width: 1.7,
        height: 0.62,
        background: css(NEAR.black),
        foreground: css(NEAR.white),
        accent: css(NEAR.hairline),
        cornerRadius: 0.06,
        borderWidth: 0.03,
        hairline: false,
        titleFont: 'sans',
        titleWeight: 400,
        titleTracking: 0.06,
        subtitleFont: 'mono',
        subtitleWeight: 600,
        subtitleTracking: 0.42,
        subtitleColor: css(NEAR.green),
        uppercase: true,
      }),
    }),
  }),
  vault: Object.freeze({
    style: 'vault',
    height: 3.9,
    // Charcoal that still shows its stonework in the warm light.
    wall: 0x61656e,
    wallAlt: 0x51555d,
    trim: 0x6d727b,
    accent: 0x8a7248,
    roof: 0x4a4d54,
    door: 0x34373d,
    windowLit: 0x5a4636,
    windowGlow: 0x6b2a20,
    windowDark: 0x1c1f24,
    glow: 0x9b2e22,
    beacon: 0x9b2e22,
    litRatio: 0,
    portal: 0x8a1f18,
    sign: Object.freeze({
      width: 2.4,
      height: 0.66,
      background: '#1d1e22',
      foreground: '#9b9da5',
      accent: '#5a2020',
    }),
    // Locked, so calm: Vesu's pale periwinkle and a thin blue edge on the
    // Vault's own charcoal, not its bright white pages.
    brand: Object.freeze({
      text: 'Vesu',
      style: Object.freeze({
        width: 1.15,
        height: 0.28,
        background: '#1d1e22',
        foreground: css(VESU.blueSoft),
        accent: css(VESU.blue),
        cornerRadius: 0.2,
        borderWidth: 0.04,
        hairline: false,
        titleFont: 'sans',
        titleWeight: 600,
        titleTracking: 0.02,
      }),
    }),
  }),
});

/** For solid footprints the map does not attribute to a known building. */
export const GENERIC_BUILDING_THEME: BuildingTheme = Object.freeze({
  style: 'generic',
  height: 4,
  wall: 0xd9c9ae,
  wallAlt: 0xbfae93,
  trim: 0xf1e8d6,
  accent: 0x8a6f4d,
  roof: 0x8e7f70,
  door: 0x6b4f36,
  windowLit: 0xffe2a8,
  windowGlow: 0xffc46b,
  windowDark: 0x3d4a5a,
  glow: 0xffd08a,
  beacon: 0xffd08a,
  litRatio: 0.5,
  portal: 0xffc766,
  sign: Object.freeze({
    width: 2.4,
    height: 0.7,
    background: '#f4ecd8',
    foreground: '#3b2a14',
    accent: '#8a6f4d',
  }),
});

export function buildingTheme(building: BuildingId | null): BuildingTheme {
  return building ? BUILDING_THEMES[building] ?? GENERIC_BUILDING_THEME : GENERIC_BUILDING_THEME;
}

/** Station render states: its accent material and its approach halo. */
export interface StationLook {
  readonly color: number;
  readonly emissive: number;
  readonly emissiveIntensity: number;
  readonly halo: number;
  readonly haloOpacity: number;
  readonly edgeOpacity: number;
}

export interface StationLooks {
  readonly available: StationLook;
  readonly highlighted: StationLook;
  readonly locked: StationLook;
  readonly lockedHighlighted: StationLook;
}

/** Default looks; the colours echo the 2D room layer's station fills. */
export const STATION_LOOKS: StationLooks = Object.freeze({
  available: Object.freeze({
    color: 0xb07b41,
    emissive: 0xffa640,
    emissiveIntensity: 0.65,
    halo: 0xffcf73,
    haloOpacity: 0.2,
    edgeOpacity: 0.55,
  }),
  highlighted: Object.freeze({
    color: 0xe2b45d,
    emissive: 0xffd66b,
    emissiveIntensity: 1.9,
    halo: 0xffe08a,
    haloOpacity: 0.48,
    edgeOpacity: 0.95,
  }),
  locked: Object.freeze({
    color: 0x665f67,
    emissive: 0x000000,
    emissiveIntensity: 0,
    halo: 0x8f8896,
    haloOpacity: 0.06,
    edgeOpacity: 0.2,
  }),
  lockedHighlighted: Object.freeze({
    color: 0x736b74,
    emissive: 0x2a2530,
    emissiveIntensity: 0.4,
    halo: 0xa9a2b0,
    haloOpacity: 0.16,
    edgeOpacity: 0.45,
  }),
});

/** avnu: primary blue when ready, light blue when you step up to it. */
export const AVNU_STATION_LOOKS: StationLooks = Object.freeze({
  available: Object.freeze({
    color: AVNU.indigoBorder,
    emissive: AVNU.blue,
    emissiveIntensity: 1,
    halo: AVNU.blue,
    haloOpacity: 0.2,
    edgeOpacity: 0.6,
  }),
  highlighted: Object.freeze({
    color: AVNU.lightBlue,
    emissive: AVNU.lightBlue,
    emissiveIntensity: 2.2,
    halo: AVNU.lightBlue,
    haloOpacity: 0.45,
    edgeOpacity: 0.95,
  }),
  locked: Object.freeze({
    color: lift(AVNU.slate, -0.18),
    emissive: 0x000000,
    emissiveIntensity: 0,
    halo: AVNU.slate,
    haloOpacity: 0.06,
    edgeOpacity: 0.2,
  }),
  lockedHighlighted: Object.freeze({
    color: AVNU.slate,
    emissive: AVNU.indigo,
    emissiveIntensity: 0.5,
    halo: AVNU.slate,
    haloOpacity: 0.16,
    edgeOpacity: 0.45,
  }),
});

/** STRK20: the burnt-orange accent, glowing at its measured 55 % alpha when active. */
export const STRK20_STATION_LOOKS: StationLooks = Object.freeze({
  available: Object.freeze({
    color: STRK20.orangePressed,
    emissive: STRK20.orange,
    emissiveIntensity: 1.2,
    halo: STRK20.orange,
    haloOpacity: 0.2,
    edgeOpacity: 0.6,
  }),
  highlighted: Object.freeze({
    color: STRK20.orange,
    emissive: STRK20.orange,
    emissiveIntensity: 2.6,
    halo: STRK20.orange,
    haloOpacity: STRK20.glowAlpha,
    edgeOpacity: 1,
  }),
  locked: Object.freeze({
    color: lift(STRK20.hairline, 0.08),
    emissive: 0x000000,
    emissiveIntensity: 0,
    halo: 0x6b6b6b,
    haloOpacity: 0.06,
    edgeOpacity: 0.2,
  }),
  lockedHighlighted: Object.freeze({
    color: lift(STRK20.hairline, 0.12),
    emissive: STRK20.orangePressed,
    emissiveIntensity: 0.25,
    halo: 0x8a8a8a,
    haloOpacity: 0.16,
    edgeOpacity: 0.45,
  }),
});

/**
 * NEAR: green when ready, brighter green with its tint as the halo when you
 * step up to it. Locked only means not enabled yet, so it stays neutral grey;
 * amber (pending) is kept for the room's decor.
 */
export const NEAR_STATION_LOOKS: StationLooks = Object.freeze({
  // A near-black green body under a low green glow: ACES bleaches a bright
  // green to mint, so the halo (unlit, exact colour) carries the highlight.
  available: Object.freeze({
    color: lift(NEAR.green, -0.38),
    emissive: NEAR.green,
    emissiveIntensity: 0.5,
    halo: NEAR.green,
    haloOpacity: 0.2,
    edgeOpacity: 0.6,
  }),
  highlighted: Object.freeze({
    color: lift(NEAR.green, -0.34),
    emissive: NEAR.green,
    emissiveIntensity: 0.8,
    halo: NEAR.greenTint,
    haloOpacity: 0.42,
    edgeOpacity: 1,
  }),
  locked: Object.freeze({
    color: lift(NEAR.hairline, 0.08),
    emissive: 0x000000,
    emissiveIntensity: 0,
    halo: NEAR.muted,
    haloOpacity: 0.06,
    edgeOpacity: 0.2,
  }),
  lockedHighlighted: Object.freeze({
    color: lift(NEAR.hairline, 0.13),
    emissive: lift(NEAR.muted, -0.3),
    emissiveIntensity: 0.3,
    halo: NEAR.muted,
    haloOpacity: 0.16,
    edgeOpacity: 0.45,
  }),
});

/**
 * Endur, a light brand: its muted green when ready and brighter with a mint
 * halo when you step up to it. Locked, the production default while staking
 * is switched off (D-063), is a calm grey, nothing alarming.
 */
export const ENDUR_STATION_LOOKS: StationLooks = Object.freeze({
  // A small glow only: the muted green should read as Endur's, not neon.
  available: Object.freeze({
    color: ENDUR.green,
    emissive: ENDUR.greenDeep,
    emissiveIntensity: 0.25,
    halo: ENDUR.green,
    haloOpacity: 0.22,
    edgeOpacity: 0.6,
  }),
  highlighted: Object.freeze({
    color: mixHex(ENDUR.green, ENDUR.card, 0.2),
    emissive: ENDUR.green,
    emissiveIntensity: 0.8,
    halo: mixHex(ENDUR.green, ENDUR.base, 0.55),
    haloOpacity: 0.42,
    edgeOpacity: 1,
  }),
  locked: Object.freeze({
    color: lift(ENDUR.border, -0.2),
    emissive: 0x000000,
    emissiveIntensity: 0,
    halo: lift(ENDUR.border, -0.3),
    haloOpacity: 0.06,
    edgeOpacity: 0.2,
  }),
  lockedHighlighted: Object.freeze({
    color: lift(ENDUR.border, -0.12),
    emissive: lift(ENDUR.border, -0.6),
    emissiveIntensity: 0.3,
    halo: lift(ENDUR.border, -0.2),
    haloOpacity: 0.16,
    edgeOpacity: 0.45,
  }),
});

export type RoomDecorStyle = 'strk20' | 'avnu' | 'degen' | 'post-office' | 'bridge' | 'plain';

/**
 * The Degen floor's counter: hot pink when ready, brighter with a lime halo
 * when you step up to it, and a calm dark violet while locked (the default
 * until the Shell opens it).
 */
export const DEGEN_STATION_LOOKS: StationLooks = Object.freeze({
  available: Object.freeze({
    color: DEGEN.pinkDeep,
    emissive: DEGEN.pink,
    emissiveIntensity: 0.9,
    halo: DEGEN.pink,
    haloOpacity: 0.24,
    edgeOpacity: 0.7,
  }),
  highlighted: Object.freeze({
    color: DEGEN.pink,
    emissive: DEGEN.pink,
    emissiveIntensity: 1.8,
    halo: DEGEN.lime,
    haloOpacity: 0.42,
    edgeOpacity: 1,
  }),
  locked: Object.freeze({
    color: lift(AVNU.indigo, 0.12),
    emissive: 0x000000,
    emissiveIntensity: 0,
    halo: lift(DEGEN.violet, -0.25),
    haloOpacity: 0.07,
    edgeOpacity: 0.22,
  }),
  lockedHighlighted: Object.freeze({
    color: lift(AVNU.indigo, 0.2),
    emissive: lift(DEGEN.violet, -0.3),
    emissiveIntensity: 0.35,
    halo: lift(DEGEN.violet, -0.1),
    haloOpacity: 0.16,
    edgeOpacity: 0.45,
  }),
});

/** Counter-top props: a room's decor style, or a station's own brand. */
export type StationPropStyle = RoomDecorStyle | 'endur';

/**
 * How one station dresses: counter, props, label and state looks. A room's
 * stations wear the room's theme unless it names one of its own, as the
 * Bank's Endur staking counter does (D-063).
 */
export interface StationTheme {
  readonly props: StationPropStyle;
  readonly kioskBase: number;
  readonly kioskTop: number;
  /** Kick plate and trim; a shade of the base when absent. */
  readonly kioskTrim?: number;
  readonly label: FloatingStyleOptions;
  readonly looks: StationLooks;
  /** The protocol's name on the counter's status panel, beside the Shell's label. */
  readonly plate?: BrandPlate;
}

/** The Bank's staking counter: Endur's light look, inside the STRK20 room. */
export const ENDUR_STATION_THEME: StationTheme = Object.freeze({
  props: 'endur',
  kioskBase: ENDUR.base,
  kioskTop: ENDUR.card,
  kioskTrim: ENDUR.dark,
  // A white pill badge with dark green text, as Endur's are.
  label: Object.freeze({
    foreground: css(ENDUR.dark),
    background: cssAlpha(ENDUR.card, 0.96),
    border: css(ENDUR.border),
    font: 'sans',
    cornerRadius: 0.5,
  }),
  looks: ENDUR_STATION_LOOKS,
  // Endur's name as a white pill with dark green type and a green edge, set
  // into the status panel, whose colour frames it.
  plate: Object.freeze({
    text: 'Endur',
    style: Object.freeze({
      width: 1.24,
      height: 0.3,
      background: css(ENDUR.card),
      foreground: css(ENDUR.dark),
      accent: css(ENDUR.green),
      cornerRadius: 0.5,
      borderWidth: 0.06,
      hairline: false,
      titleFont: 'sans',
      titleWeight: 700,
    }),
  }),
});

/** Interior palette for one fixed room. */
export interface RoomTheme {
  readonly decor: RoomDecorStyle;
  readonly floorA: number;
  readonly floorB: number;
  readonly floorAccent: number;
  readonly wall: number;
  readonly wallLower: number;
  readonly wallTop: number;
  readonly trim: number;
  readonly skirting: number;
  readonly cut: number;
  readonly kioskBase: number;
  readonly kioskTop: number;
  readonly exitGlow: number;
  /** Lift pads' light (the Exchange tower's floors); the exit's glow when absent. */
  readonly liftGlow?: number;
  /** Station label style (CSS colours, type treatment). */
  readonly label: FloatingStyleOptions;
  readonly stationLooks: StationLooks;
  /** Stations dressed in their own brand instead of the room's (see `stationTheme`). */
  readonly stations?: Readonly<Partial<Record<StationId, StationTheme>>>;
}

export const ROOM_THEMES: Readonly<Partial<Record<BuildingId, RoomTheme>>> = Object.freeze({
  bank: Object.freeze({
    decor: 'strk20',
    floorA: lift(STRK20.surface, 0.07),
    floorB: lift(STRK20.raised, 0.1),
    floorAccent: STRK20.orange,
    wall: lift(STRK20.raised, 0.09),
    wallLower: lift(STRK20.surface, 0.05),
    wallTop: STRK20.black,
    trim: lift(STRK20.hairline, 0.1),
    skirting: STRK20.black,
    cut: STRK20.black,
    kioskBase: lift(STRK20.raised, 0.09),
    kioskTop: lift(STRK20.hairline, 0.15),
    exitGlow: STRK20.orange,
    label: Object.freeze({
      foreground: css(STRK20.text),
      background: cssAlpha(STRK20.surface, 0.92),
      border: css(STRK20.hairline),
      font: 'mono',
      cornerRadius: 0.08,
      tracking: 0.1,
      uppercase: true,
    }),
    stationLooks: STRK20_STATION_LOOKS,
    // Endur staking is its own counter in its own brand (D-063).
    stations: Object.freeze({ 'bank:staking': ENDUR_STATION_THEME }),
  }),
  exchange: Object.freeze({
    decor: 'avnu',
    floorA: lift(AVNU.navy, 0.07),
    floorB: lift(AVNU.card, 0.06),
    floorAccent: AVNU.indigoBorder,
    wall: lift(AVNU.indigo, 0.1),
    wallLower: lift(AVNU.card, 0.03),
    wallTop: AVNU.navy,
    trim: AVNU.blue,
    skirting: AVNU.navy,
    cut: AVNU.navy,
    kioskBase: lift(AVNU.card, 0.04),
    kioskTop: lift(AVNU.indigoBorder, 0.06),
    exitGlow: AVNU.blue,
    label: Object.freeze({
      foreground: css(AVNU.white),
      background: cssAlpha(AVNU.card, 0.92),
      border: css(AVNU.indigoBorder),
      font: 'sans',
      cornerRadius: 0.5,
    }),
    stationLooks: AVNU_STATION_LOOKS,
  }),
  'post-office': Object.freeze({
    decor: 'post-office',
    floorA: 0xb65a45,
    floorB: 0xe9dcc3,
    floorAccent: 0x2f5fa3,
    wall: 0xf1e6cf,
    wallLower: 0x2f5fa3,
    wallTop: 0x7b3528,
    trim: 0xc8513c,
    skirting: 0x243f6e,
    cut: 0x5a2a20,
    kioskBase: 0x8a5a3a,
    kioskTop: 0xc49a6c,
    exitGlow: 0xffc070,
    label: Object.freeze({ foreground: '#fff7e6', background: 'rgba(28,48,92,0.86)' }),
    stationLooks: STATION_LOOKS,
  }),
  bridge: Object.freeze({
    decor: 'bridge',
    floorA: lift(NEAR.surface, 0.08),
    floorB: lift(NEAR.raised, 0.08),
    floorAccent: NEAR.green,
    wall: lift(NEAR.raised, 0.1),
    wallLower: lift(NEAR.surface, 0.06),
    wallTop: NEAR.black,
    trim: lift(NEAR.hairline, 0.12),
    skirting: NEAR.black,
    cut: NEAR.black,
    kioskBase: lift(NEAR.raised, 0.09),
    kioskTop: lift(NEAR.hairline, 0.16),
    exitGlow: NEAR.green,
    label: Object.freeze({
      foreground: css(NEAR.white),
      background: cssAlpha(NEAR.black, 0.9),
      border: css(NEAR.hairline),
      font: 'mono',
      cornerRadius: 0.12,
      tracking: 0.16,
      uppercase: true,
    }),
    stationLooks: NEAR_STATION_LOOKS,
  }),
});

export const DEFAULT_ROOM_THEME: RoomTheme = Object.freeze({
  decor: 'plain',
  floorA: 0x6a6272,
  floorB: 0x5f5867,
  floorAccent: 0xd6b36a,
  wall: 0x6f6878,
  wallLower: 0x5c5664,
  wallTop: 0x39343b,
  trim: 0xd6b36a,
  skirting: 0x39343b,
  cut: 0x241f27,
  kioskBase: 0x5c5664,
  kioskTop: 0x9d93a8,
  exitGlow: 0xffd08a,
  label: Object.freeze({ foreground: '#fff6e0', background: 'rgba(28,22,32,0.84)' }),
  stationLooks: STATION_LOOKS,
});

/**
 * The Exchange tower's Degen floor: avnu's walls and floor, louder. Neon pink
 * trim and floor light, lime lift pads, the same navy label type.
 */
export const DEGEN_ROOM_THEME: RoomTheme = Object.freeze({
  decor: 'degen',
  floorA: lift(AVNU.navy, 0.07),
  floorB: lift(AVNU.card, 0.06),
  floorAccent: DEGEN.pink,
  wall: lift(AVNU.indigo, 0.1),
  wallLower: lift(AVNU.card, 0.03),
  wallTop: AVNU.navy,
  trim: DEGEN.pink,
  skirting: AVNU.navy,
  cut: AVNU.navy,
  kioskBase: lift(AVNU.card, 0.04),
  kioskTop: lift(AVNU.indigoBorder, 0.06),
  exitGlow: DEGEN.pink,
  liftGlow: DEGEN.lime,
  label: Object.freeze({
    foreground: css(AVNU.white),
    background: cssAlpha(AVNU.navy, 0.92),
    border: css(DEGEN.pink),
    font: 'sans',
    cornerRadius: 0.5,
  }),
  stationLooks: DEGEN_STATION_LOOKS,
});

/** Floors reached by lift, by building and floor. */
export const ROOM_LEVEL_THEMES: Readonly<Partial<Record<BuildingId, Readonly<Partial<Record<FixedRoomLevelId, RoomTheme>>>>>> =
  Object.freeze({ exchange: Object.freeze({ degen: DEGEN_ROOM_THEME }) });

/** A floor's theme: a lift-only floor's own, else its building's ground-floor room. */
export function roomTheme(building: BuildingId, level: FixedRoomLevelId = 'ground'): RoomTheme {
  if (level !== 'ground') {
    const theme = ROOM_LEVEL_THEMES[building]?.[level];
    if (theme) return theme;
  }
  return ROOM_THEMES[building] ?? DEFAULT_ROOM_THEME;
}

/** What a station wears: its own theme if its room names one, else the room's. */
export function stationTheme(room: RoomTheme, station: StationId): StationTheme {
  return (
    room.stations?.[station] ?? {
      props: room.decor,
      kioskBase: room.kioskBase,
      kioskTop: room.kioskTop,
      label: room.label,
      looks: room.stationLooks,
    }
  );
}

/** Avatar Studio accents; floor and wall tones come from `avatarStudioTileColour`. */
export const STUDIO_THEME = Object.freeze({
  wallLower: 0x2e2a31,
  wallTop: 0x241f27,
  trim: 0x8a7fa0,
  skirting: 0x241f27,
  cut: 0x19161b,
  pad: 0x6a6278,
  padRim: 0xc4b2ec,
  highlight: 0xffd66b,
  portal: 0xffe0a0,
  mirror: 0xdfe8ff,
  rug: 0x6c4f7a,
  rugBorder: 0xb89ad0,
  rack: 0x2a262d,
  garments: Object.freeze([0xe57373, 0x64b5f6, 0xffd54f, 0x81c784, 0xba68c8, 0xf4f0e6]),
  spot: 0xfff1cf,
  signBackground: '#241f27',
  signForeground: '#f1e6ff',
  signAccent: '#c4b2ec',
});

// ---------------------------------------------------------------------------
// Deterministic noise and colour helpers
// ---------------------------------------------------------------------------

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Integer hash in [0, 1). Decor placement must not change between loads. */
export function hash01(a: number, b = 0, c = 0): number {
  let h =
    (Math.imul(a | 0, 0x9e3779b1) ^
      Math.imul(b | 0, 0x85ebca77) ^
      Math.imul(c | 0, 0xc2b2ae3d) ^
      0x2545f491) >>>
    0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0, 1], for meadow-scale colour patches. */
export function valueNoise(x: number, z: number, seed = 0): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash01(ix, iz, seed);
  const b = hash01(ix + 1, iz, seed);
  const c = hash01(ix, iz + 1, seed);
  const d = hash01(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

const scratchHsl = { h: 0, s: 0, l: 0 };

/** Offset lightness (and saturation) in sRGB, where the eye judges it. */
export function shade(color: ColorRepresentation, lightness: number, saturation = 0): Color {
  const out = new Color(color);
  out.getHSL(scratchHsl, SRGBColorSpace);
  out.setHSL(
    scratchHsl.h,
    clamp01(scratchHsl.s + saturation),
    clamp01(scratchHsl.l + lightness),
    SRGBColorSpace,
  );
  return out;
}

/** `seed` in [0, 1) maps to a lightness offset of +-amount. */
export function jitterColor(color: ColorRepresentation, seed: number, amount = 0.04): Color {
  return shade(color, (seed - 0.5) * 2 * amount);
}

export function mixColor(a: ColorRepresentation, b: ColorRepresentation, t: number): Color {
  return new Color(a).lerp(new Color(b), clamp01(t));
}

/**
 * Darken towards the ground: cheap ambient occlusion baked into vertex
 * colour, so walls sit on the floor instead of floating on it.
 */
export function aoPaint(color: ColorRepresentation, strength = 0.07, reach = 1.4): (x: number, y: number, z: number) => Color {
  return (_x, y) => shade(color, -strength * (1 - clamp01(y / reach)));
}

/** Contiguous [start, end) runs of indices in [from, to) where `test` holds. */
export function runsWhere(test: (index: number) => boolean, from: number, to: number): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = from; i <= to; i++) {
    const inside = i < to && test(i);
    if (inside && start < 0) start = i;
    if (!inside && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }
  return runs;
}

export function pick<T>(values: readonly T[], seed: number): T {
  const index = Math.min(values.length - 1, Math.floor(clamp01(seed) * values.length));
  return values[index]!;
}

// ---------------------------------------------------------------------------
// Resource ownership
// ---------------------------------------------------------------------------

/**
 * Owns every GPU resource a builder creates, so `dispose()` is one idempotent
 * call and nothing is released twice.
 */
export class ResourceBag {
  private readonly geometries = new Set<BufferGeometry>();
  private readonly materials = new Set<Material>();
  private readonly textures = new Set<Texture>();
  private readonly others = new Set<{ dispose(): void }>();
  private released = false;

  get disposed(): boolean {
    return this.released;
  }

  geometry<T extends BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  material<T extends Material>(material: T): T {
    this.materials.add(material);
    return material;
  }

  texture<T extends Texture>(texture: T): T {
    this.textures.add(texture);
    return texture;
  }

  /** Anything else with a `dispose()`, such as an InstancedMesh's buffers. */
  disposable<T extends { dispose(): void }>(value: T): T {
    this.others.add(value);
    return value;
  }

  dispose(): void {
    if (this.released) return;
    this.released = true;
    for (const value of this.others) value.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.others.clear();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
  }
}

// ---------------------------------------------------------------------------
// Geometry bins: merge static geometry per material
// ---------------------------------------------------------------------------

export type PaintFn = (x: number, y: number, z: number) => Color;
export type Paint = ColorRepresentation | PaintFn;
export type PaintRGBA = (x: number, y: number, z: number) => readonly [number, number, number, number];

/**
 * Collects world-space pieces per material key and merges each key into one
 * geometry with baked vertex colours. One key becomes one draw call, which is
 * how a whole building with hundreds of parts costs four.
 */
export class GeometryBin {
  private readonly parts = new Map<string, BufferGeometry[]>();
  private readonly itemSizes = new Map<string, number>();

  add(key: string, geometry: BufferGeometry, paint: Paint): void {
    const prepared = prepareGeometry(geometry);
    const position = prepared.getAttribute('position');
    const colors = new Float32Array(position.count * 3);
    if (typeof paint === 'function') {
      for (let i = 0; i < position.count; i++) {
        const color = paint(position.getX(i), position.getY(i), position.getZ(i));
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
    } else {
      const color = paint instanceof Color ? paint : new Color(paint);
      for (let i = 0; i < position.count; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
    }
    prepared.setAttribute('color', new BufferAttribute(colors, 3));
    this.push(key, prepared, 3);
  }

  /** Linear RGB plus alpha per vertex, for gradient light decals. */
  addRGBA(key: string, geometry: BufferGeometry, paint: PaintRGBA): void {
    const prepared = prepareGeometry(geometry);
    const position = prepared.getAttribute('position');
    const colors = new Float32Array(position.count * 4);
    for (let i = 0; i < position.count; i++) {
      const [r, g, b, a] = paint(position.getX(i), position.getY(i), position.getZ(i));
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
    }
    prepared.setAttribute('color', new BufferAttribute(colors, 4));
    this.push(key, prepared, 4);
  }

  has(key: string): boolean {
    return (this.parts.get(key)?.length ?? 0) > 0;
  }

  /** Merge and remove one key. The caller owns (and must track) the result. */
  take(key: string): BufferGeometry | null {
    const parts = this.parts.get(key);
    this.parts.delete(key);
    this.itemSizes.delete(key);
    if (!parts || parts.length === 0) return null;
    if (parts.length === 1) {
      const only = parts[0]!;
      only.computeBoundingBox();
      only.computeBoundingSphere();
      return only;
    }
    const merged = mergeGeometries(parts, false) as BufferGeometry | null;
    for (const part of parts) part.dispose();
    if (!merged) throw new Error(`Could not merge the "${key}" geometry bin`);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  /** Release anything not yet taken (construction failed part-way). */
  dispose(): void {
    for (const parts of this.parts.values()) for (const part of parts) part.dispose();
    this.parts.clear();
    this.itemSizes.clear();
  }

  private push(key: string, geometry: BufferGeometry, itemSize: number): void {
    const known = this.itemSizes.get(key);
    if (known !== undefined && known !== itemSize) {
      geometry.dispose();
      throw new Error(`Geometry bin "${key}" mixes RGB and RGBA paint`);
    }
    this.itemSizes.set(key, itemSize);
    const list = this.parts.get(key);
    if (list) list.push(geometry);
    else this.parts.set(key, [geometry]);
  }
}

/** Non-indexed, position + normal only: the shape every bin part shares. */
function prepareGeometry(geometry: BufferGeometry): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name);
  }
  if (!flat.getAttribute('normal')) flat.computeVertexNormals();
  flat.morphAttributes = {};
  flat.clearGroups();
  return flat;
}

export interface MeshOptions {
  readonly name: string;
  readonly cast?: boolean;
  readonly receive?: boolean;
  readonly renderOrder?: number;
}

export function makeMesh(geometry: BufferGeometry, material: Material, options: MeshOptions): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.name = options.name;
  mesh.castShadow = options.cast ?? false;
  mesh.receiveShadow = options.receive ?? false;
  if (options.renderOrder !== undefined) mesh.renderOrder = options.renderOrder;
  return mesh;
}

/** Take one bin key into a tracked mesh under `parent`; null when the key is empty. */
export function flushBin(
  bin: GeometryBin,
  key: string,
  material: Material,
  res: ResourceBag,
  parent: Object3D,
  options: MeshOptions,
): Mesh | null {
  const geometry = bin.take(key);
  if (!geometry) return null;
  res.geometry(geometry);
  const mesh = makeMesh(geometry, material, options);
  parent.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Primitives (world space, ready for a bin)
// ---------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number];
export type Point2 = readonly [number, number];

/** Axis-aligned box from two corners. */
export function boxGeometry(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): BufferGeometry {
  const minX = Math.min(x0, x1);
  const minY = Math.min(y0, y1);
  const minZ = Math.min(z0, z1);
  const w = Math.max(1e-4, Math.abs(x1 - x0));
  const h = Math.max(1e-4, Math.abs(y1 - y0));
  const d = Math.max(1e-4, Math.abs(z1 - z0));
  return new BoxGeometry(w, h, d).translate(minX + w / 2, minY + h / 2, minZ + d / 2);
}

export function cylinderGeometry(
  x: number,
  y0: number,
  z: number,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments = 8,
): BufferGeometry {
  return new CylinderGeometry(radiusTop, radiusBottom, height, segments).translate(
    x,
    y0 + height / 2,
    z,
  );
}

export function coneGeometry(
  x: number,
  y0: number,
  z: number,
  radius: number,
  height: number,
  segments = 8,
): BufferGeometry {
  return new ConeGeometry(radius, height, segments).translate(x, y0 + height / 2, z);
}

/** A (possibly squashed) sphere or upper hemisphere. */
export function sphereGeometry(
  x: number,
  y: number,
  z: number,
  radius: number,
  options: { widthSegments?: number; heightSegments?: number; hemisphere?: boolean; scaleY?: number } = {},
): BufferGeometry {
  const geometry = new SphereGeometry(
    radius,
    options.widthSegments ?? 8,
    options.heightSegments ?? 5,
    0,
    Math.PI * 2,
    0,
    options.hemisphere ? Math.PI / 2 : Math.PI,
  );
  if (options.scaleY !== undefined) geometry.scale(1, options.scaleY, 1);
  return geometry.translate(x, y, z);
}

/** Horizontal quad facing +Y. */
export function flatQuad(x0: number, z0: number, x1: number, z1: number, y: number): BufferGeometry {
  const ax = Math.min(x0, x1);
  const bx = Math.max(x0, x1);
  const az = Math.min(z0, z1);
  const bz = Math.max(z0, z1);
  const positions = [ax, y, az, ax, y, bz, bx, y, bz, ax, y, az, bx, y, bz, bx, y, az];
  const normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  return geometry;
}

/** Convex horizontal polygon (x, z) facing +Y. */
export function flatPolygon(points: readonly Point2[], y: number): BufferGeometry {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  // Up-facing triangles wind clockwise in (x, z): reverse a positive-area loop.
  const loop = area > 0 ? [...points].reverse() : [...points];
  const positions: number[] = [];
  const first = loop[0]!;
  for (let i = 1; i + 1 < loop.length; i++) {
    const b = loop[i]!;
    const c = loop[i + 1]!;
    positions.push(first[0], y, first[1], b[0], y, b[1], c[0], y, c[1]);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Extrude a convex polygon in the XY plane between z0 and z1. */
export function prismZ(points: readonly Point2[], z0: number, z1: number): BufferGeometry {
  const back = Math.min(z0, z1);
  const front = Math.max(z0, z1);
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const loop = area < 0 ? [...points].reverse() : [...points];
  const positions: number[] = [];
  const push = (p: Point2, z: number): void => {
    positions.push(p[0], p[1], z);
  };
  const first = loop[0]!;
  for (let i = 1; i + 1 < loop.length; i++) {
    const b = loop[i]!;
    const c = loop[i + 1]!;
    push(first, front);
    push(b, front);
    push(c, front);
    push(first, back);
    push(c, back);
    push(b, back);
  }
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    push(a, front);
    push(a, back);
    push(b, back);
    push(a, front);
    push(b, back);
    push(b, front);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Extrude a convex polygon given in (z, y) between x0 and x1 (gable roofs). */
export function prismX(points: readonly Point2[], x0: number, x1: number): BufferGeometry {
  // Local x becomes world z and local z becomes world -x after the rotation.
  return prismZ(points, -Math.max(x0, x1), -Math.min(x0, x1)).rotateY(-Math.PI / 2);
}

/** Extrude a convex polygon given in (x, z) between heights y0 and y1 (slabs, canopies). */
export function prismY(points: readonly Point2[], y0: number, y1: number): BufferGeometry {
  // Local y becomes world z and local z becomes world -y after the rotation.
  return prismZ(points, -Math.max(y0, y1), -Math.min(y0, y1)).rotateX(Math.PI / 2);
}

/** Outline of a pill (stadium) running along x, for convex prisms. */
export function stadiumPoints(cx: number, cz: number, halfLength: number, radius: number, segments = 6): Point2[] {
  const r = Math.max(1e-3, Math.min(radius, halfLength));
  const a = cx - halfLength + r;
  const b = cx + halfLength - r;
  const points: Point2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / segments;
    points.push([b + Math.cos(t) * r, cz + Math.sin(t) * r]);
  }
  for (let i = 0; i <= segments; i++) {
    const t = Math.PI / 2 + (Math.PI * i) / segments;
    points.push([a + Math.cos(t) * r, cz + Math.sin(t) * r]);
  }
  return points;
}

/** A rounded rectangle centred on the origin; radius clamps to a pill. */
export function roundedRectShape(width: number, height: number, radius: number): Shape {
  const w = Math.max(1e-4, width);
  const h = Math.max(1e-4, height);
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const x = -w / 2;
  const y = -h / 2;
  const shape = new Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  if (r > 0) shape.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(x + w, y + h - r);
  if (r > 0) shape.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  shape.lineTo(x + r, y + h);
  if (r > 0) shape.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(x, y + r);
  if (r > 0) shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/** A flat rounded rectangle on a face, `w` out from the plane: cards, pills, screens. */
export function facePanel(
  face: Face,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  w: number,
  radius: number,
  curveSegments = 4,
): BufferGeometry {
  const geometry = new ShapeGeometry(roundedRectShape(Math.abs(u1 - u0), Math.abs(v1 - v0), radius), curveSegments);
  orientToFace(geometry, face.normal, 'z');
  const [x, y, z] = faceToWorld(face, (u0 + u1) / 2, (v0 + v1) / 2, w);
  return geometry.translate(x, y, z);
}

/** A flat rounded rectangle facing up. */
export function flatPanel(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
  radius: number,
  curveSegments = 4,
): BufferGeometry {
  return new ShapeGeometry(roundedRectShape(Math.abs(x1 - x0), Math.abs(z1 - z0), radius), curveSegments)
    .rotateX(-Math.PI / 2)
    .translate((x0 + x1) / 2, y, (z0 + z1) / 2);
}

const scratchA = new Vector3();
const scratchB = new Vector3();
const scratchUp = new Vector3();
const scratchMatrix = new Matrix4();

/** A square-section beam from `a` to `b` (truss members, chains, arches). */
export function beamGeometry(a: Vec3, b: Vec3, thickness: number, depth = thickness): BufferGeometry {
  scratchA.set(a[0], a[1], a[2]);
  scratchB.set(b[0], b[1], b[2]);
  const length = Math.max(1e-4, scratchA.distanceTo(scratchB));
  const geometry = new BoxGeometry(thickness, depth, length);
  const vertical = Math.abs(b[1] - a[1]) > 0.999 * length;
  scratchUp.set(vertical ? 1 : 0, vertical ? 0 : 1, 0);
  scratchMatrix.lookAt(scratchA, scratchB, scratchUp);
  scratchMatrix.setPosition(
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    (a[2] + b[2]) / 2,
  );
  return geometry.applyMatrix4(scratchMatrix);
}

/**
 * A wall surface: `plane` is where the face sits and `normal` which way it
 * looks. Face coordinates are (u along the wall, v up, w out of the wall),
 * so one decor routine can dress a north, east or west wall.
 */
export type FaceNormal = 'x+' | 'x-' | 'z+' | 'z-';

export interface Face {
  readonly normal: FaceNormal;
  readonly plane: number;
}

export function faceToWorld(face: Face, u: number, v: number, w: number): Vec3 {
  switch (face.normal) {
    case 'z+':
      return [u, v, face.plane + w];
    case 'z-':
      return [u, v, face.plane - w];
    case 'x+':
      return [face.plane + w, v, u];
    case 'x-':
      return [face.plane - w, v, u];
  }
}

export function faceBox(
  face: Face,
  u0: number,
  v0: number,
  w0: number,
  u1: number,
  v1: number,
  w1: number,
): BufferGeometry {
  const a = faceToWorld(face, u0, v0, w0);
  const b = faceToWorld(face, u1, v1, w1);
  return boxGeometry(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/** A flat rectangle lying on a face, `w` out from the plane. */
export function faceQuad(
  face: Face,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  w: number,
): BufferGeometry {
  const geometry = new PlaneGeometry(Math.max(1e-4, Math.abs(u1 - u0)), Math.max(1e-4, Math.abs(v1 - v0)));
  orientToFace(geometry, face.normal, 'z');
  const [x, y, z] = faceToWorld(face, (u0 + u1) / 2, (v0 + v1) / 2, w);
  return geometry.translate(x, y, z);
}

/** A disc (short cylinder) standing out of a face. */
export function faceDisc(
  face: Face,
  u: number,
  v: number,
  w0: number,
  radius: number,
  depth: number,
  segments = 12,
): BufferGeometry {
  const geometry = new CylinderGeometry(radius, radius, depth, segments);
  orientToFace(geometry, face.normal, 'y');
  const [x, y, z] = faceToWorld(face, u, v, w0 + depth / 2);
  return geometry.translate(x, y, z);
}

/** A torus (or arc of one) lying flat against a face. */
export function faceTorus(
  face: Face,
  u: number,
  v: number,
  w: number,
  radius: number,
  tube: number,
  options: { radialSegments?: number; tubularSegments?: number; arc?: number; rotation?: number } = {},
): BufferGeometry {
  const geometry = new TorusGeometry(
    radius,
    tube,
    options.radialSegments ?? 4,
    options.tubularSegments ?? 12,
    options.arc ?? Math.PI * 2,
  );
  if (options.rotation) geometry.rotateZ(options.rotation);
  orientToFace(geometry, face.normal, 'z');
  const [x, y, z] = faceToWorld(face, u, v, w);
  return geometry.translate(x, y, z);
}

/** A horizontal pipe running along a face's u axis. */
export function facePipe(
  face: Face,
  u0: number,
  u1: number,
  v: number,
  w: number,
  radius: number,
  segments = 6,
): BufferGeometry {
  const geometry = new CylinderGeometry(radius, radius, Math.max(1e-4, Math.abs(u1 - u0)), segments);
  if (face.normal === 'z+' || face.normal === 'z-') geometry.rotateZ(Math.PI / 2);
  else geometry.rotateX(Math.PI / 2);
  const [x, y, z] = faceToWorld(face, (u0 + u1) / 2, v, w);
  return geometry.translate(x, y, z);
}

/** Point a geometry's local +Z (or +Y) axis along a face normal. */
function orientToFace(geometry: BufferGeometry, normal: FaceNormal, axis: 'y' | 'z'): void {
  if (axis === 'y') geometry.rotateX(Math.PI / 2);
  switch (normal) {
    case 'z+':
      return;
    case 'z-':
      geometry.rotateY(Math.PI);
      return;
    case 'x+':
      geometry.rotateY(Math.PI / 2);
      return;
    case 'x-':
      geometry.rotateY(-Math.PI / 2);
      return;
  }
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface StandardSpec {
  readonly color?: ColorRepresentation;
  readonly roughness?: number;
  readonly metalness?: number;
  readonly emissive?: ColorRepresentation;
  readonly emissiveIntensity?: number;
  readonly vertexColors?: boolean;
}

/** The house material: flat-shaded, matte, vertex coloured by default. */
export function standardMaterial(spec: StandardSpec = {}): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: spec.color ?? 0xffffff,
    roughness: spec.roughness ?? 0.86,
    metalness: spec.metalness ?? 0,
    flatShading: true,
    vertexColors: spec.vertexColors ?? true,
    emissive: spec.emissive ?? 0x000000,
    emissiveIntensity: spec.emissiveIntensity ?? 1,
  });
}

export interface UnlitSpec {
  readonly color?: ColorRepresentation;
  readonly opacity?: number;
  readonly additive?: boolean;
  readonly transparent?: boolean;
  readonly vertexColors?: boolean;
  readonly doubleSide?: boolean;
}

/**
 * Self-lit surfaces: screens, fairy lights, halos, light spills. Not tone
 * mapped, so a glow reads as a glow under the ACES curve.
 */
export function unlitMaterial(spec: UnlitSpec = {}): MeshBasicMaterial {
  const opacity = spec.opacity ?? 1;
  const transparent = spec.transparent === true || spec.additive === true || opacity < 1;
  return new MeshBasicMaterial({
    color: spec.color ?? 0xffffff,
    vertexColors: spec.vertexColors ?? true,
    transparent,
    opacity,
    depthWrite: !transparent,
    blending: spec.additive ? AdditiveBlending : NormalBlending,
    toneMapped: false,
    side: spec.doubleSide ? DoubleSide : FrontSide,
  });
}

// ---------------------------------------------------------------------------
// Occluder fading
// ---------------------------------------------------------------------------

/**
 * Fade a fixed set of materials together. The originals are captured once, so
 * returning to 1 restores `transparent` and `depthWrite` exactly; while faded,
 * depth writes are off so the ghosted building cannot hide what is behind it.
 * Changing `transparent` changes the shader program, hence `needsUpdate`.
 */
export function createOpacityFader(materials: readonly Material[]): (opacity: number) => void {
  const entries = [...new Set(materials)].map((material) => ({
    material,
    opacity: material.opacity,
    transparent: material.transparent,
    depthWrite: material.depthWrite,
    visible: material.visible,
  }));
  let current = 1;
  return (requested: number): void => {
    const next = Number.isFinite(requested) ? clamp01(requested) : 1;
    if (next === current) return;
    const wasFaded = current < 1;
    const faded = next < 1;
    current = next;
    for (const entry of entries) {
      entry.material.opacity = entry.opacity * next;
      entry.material.visible = entry.visible && next > 0.001;
      if (faded !== wasFaded) {
        entry.material.transparent = faded ? true : entry.transparent;
        entry.material.depthWrite = faded ? false : entry.depthWrite;
        entry.material.needsUpdate = true;
      }
    }
  };
}

export function occluderFor(bounds: OccluderBounds, materials: readonly Material[]): Occluder {
  return Object.freeze({
    bounds: Object.freeze({ ...bounds }),
    setOpacity: createOpacityFader(materials),
  });
}

// ---------------------------------------------------------------------------
// LED ticker strip (a DataTexture: no canvas, so node-safe)
// ---------------------------------------------------------------------------

/**
 * Pixel glyphs, five rows tall, row-major from the top; a glyph's width is
 * its length / 5 (letters are 3 wide, the arrows 5 so they read as arrows).
 */
const GLYPHS: Readonly<Record<string, string>> = Object.freeze({
  A: '010101111101101',
  B: '110101110101110',
  C: '011100100100011',
  D: '110101101101110',
  E: '111100110100111',
  F: '111100110100100',
  G: '011100101101011',
  H: '101101111101101',
  I: '111010010010111',
  J: '001001001101010',
  K: '101101110101101',
  L: '100100100100111',
  M: '101111111101101',
  N: '110101101101101',
  O: '010101101101010',
  P: '110101110100100',
  Q: '010101101110011',
  R: '110101110101101',
  S: '011100010001110',
  T: '111010010010010',
  U: '101101101101111',
  V: '101101101101010',
  W: '101101111111101',
  X: '101101010101101',
  Y: '101101010010010',
  Z: '111001010100111',
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '110001010100111',
  '3': '110001010001110',
  '4': '101101111001001',
  '5': '111100110001110',
  '6': '011100111101111',
  '7': '111001010010010',
  '8': '111101111101111',
  '9': '111101111001110',
  '.': '000000000000010',
  '-': '000000111000000',
  '+': '000010111010000',
  '/': '001001010100100',
  '▲': '0000000100011101111100000',
  '▼': '0000011111011100010000000',
  '?': '110001010000010',
  // Lowercase, x-height only: enough for the one wordmark on the ticker.
  a: '000000011101011',
  n: '000000110101101',
  u: '000000101101011',
  v: '000000101101010',
});

export interface TickerSegment {
  readonly text: string;
  readonly color: number;
}

export interface TickerStrip {
  readonly texture: DataTexture;
  /** Pixel size; the strip repeats horizontally. */
  readonly width: number;
  readonly height: number;
}

/**
 * avnu's blue LED pairs; the rooftop ticker also carries the route's name,
 * once. No token symbols and no price arrows: the World must not know what
 * money is (AGENTS.md §2), and invented price direction beside a real swap
 * route would read as data.
 */
export const EXCHANGE_ROOM_TICKER: readonly TickerSegment[] = Object.freeze([
  { text: 'SWAP', color: AVNU.lightBlue },
  { text: '   STRKWORLD EXCHANGE', color: AVNU.white },
  { text: '    ', color: 0 },
]);

/** The Exchange tower's floors, bottom to top, and what a lift's label calls them. */
export const LEVEL_ORDER: readonly FixedRoomLevelId[] = Object.freeze(['ground', 'degen', 'roof']);
export const LEVEL_NAMES: Readonly<Record<FixedRoomLevelId, string>> = Object.freeze({
  ground: 'GROUND FLOOR',
  degen: 'DEGEN FLOOR',
  roof: 'ROOF',
});

/** Whether a lift from `from` to `to` goes up the tower. */
export function liftGoesUp(from: FixedRoomLevelId, to: FixedRoomLevelId): boolean {
  return LEVEL_ORDER.indexOf(to) > LEVEL_ORDER.indexOf(from);
}

/** A lift pad's label: which way it goes, and to where. */
export function liftLabelText(from: FixedRoomLevelId, to: FixedRoomLevelId): string {
  return `${liftGoesUp(from, to) ? '\u25b2' : '\u25bc'} ${LEVEL_NAMES[to]}`;
}

/** The Degen floor's LED run: the floor's name, never a token symbol or a price. */
export const DEGEN_ROOM_TICKER: readonly TickerSegment[] = Object.freeze([
  { text: 'DEGEN MODE', color: DEGEN.pink },
  { text: '   STRKWORLD EXCHANGE', color: AVNU.white },
  { text: '   avnu', color: DEGEN.lime },
  { text: '    ', color: 0 },
]);

export const EXCHANGE_TICKER: readonly TickerSegment[] = Object.freeze([
  ...EXCHANGE_ROOM_TICKER.slice(0, -1),
  { text: '    avnu', color: AVNU.lightBlue },
  { text: '    ', color: 0 },
]);

/** An LED text strip; scroll it with `texture.offset.x`. */
export function createTickerStrip(
  segments: readonly TickerSegment[],
  background: number = AVNU.navy,
): TickerStrip {
  const glyph = (char: string): string => GLYPHS[char] ?? GLYPHS[char.toUpperCase()] ?? GLYPHS['?']!;
  let width = 2;
  for (const segment of segments) {
    for (const char of segment.text) width += char === ' ' ? 2 : glyph(char).length / 5 + 1;
  }
  width = Math.max(8, width + 2);
  const height = 7;
  const data = new Uint8Array(width * height * 4);
  const put = (x: number, y: number, hex: number): void => {
    const i = (y * width + x) * 4;
    data[i] = (hex >> 16) & 0xff;
    data[i + 1] = (hex >> 8) & 0xff;
    data[i + 2] = hex & 0xff;
    data[i + 3] = 0xff;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, background);
  let cursor = 2;
  for (const segment of segments) {
    for (const char of segment.text) {
      if (char === ' ') {
        cursor += 2;
        continue;
      }
      const bits = glyph(char);
      const glyphWidth = bits.length / 5;
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < glyphWidth; col++) {
          // Texture row 0 is the bottom; glyph row 0 is the top.
          if (bits[row * glyphWidth + col] === '1') put(cursor + col, height - 2 - row, segment.color);
        }
      }
      cursor += glyphWidth + 1;
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = RepeatWrapping;
  texture.needsUpdate = true;
  return { texture, width, height };
}
