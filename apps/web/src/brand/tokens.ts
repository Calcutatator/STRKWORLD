/**
 * The STRKWORLD brand tokens (D-113, `docs/brand/README.md`), for code that
 * needs a value rather than a CSS variable. `brand.css` declares the same
 * values as `--brand-*` custom properties and loads the three faces; a test
 * keeps the two in step.
 *
 * Named for the whole game, not the title screen: the game-wide theme adopts
 * these by pointing its `--ui-*` tokens at the `--brand-*` ones.
 */
export const BRAND_COLOURS = Object.freeze({
  /** Wordmark base; primary buttons. */
  ember: '#f56a16',
  /** Wordmark top; highlights and the selected menu item. */
  sunGold: '#ffc12e',
  /** Wordmark outline; button and window outlines and their hard drops. */
  outline: '#24120a',
  /** The game's horizon and fog. */
  horizon: '#f2dcc0',
  /** The game's sky dome top. */
  sky: '#6f9edb',
  /** Street grass. */
  grass: '#86ad55',
  /** Button caps' text. */
  cream: '#fff6e6',
  /** A light window's fill. */
  windowLight: '#fff7ea',
  /** A dark window's fill. */
  windowDark: '#261810',
  /** A dark window's inner rim, so its border stays visible. */
  windowRim: '#6e3e1e',
} as const);

/** The three faces, as `font-family` names. `brand.css` self-hosts each. */
export const BRAND_FONTS = Object.freeze({
  /** Headlines, titles and big numbers. */
  headline: 'Jersey 15',
  /** Body copy: 20px minimum on screen, line-height about 1.2. */
  body: 'VT323',
  /** Buttons, tabs, menus and labels. */
  menu: 'Silkscreen',
} as const);
