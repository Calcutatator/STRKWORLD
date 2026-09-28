import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
} from 'three';
import type { FloatingLabelOptions, LabelFactory, SignOptions, TextLabel } from './types.js';

/**
 * Text for the 3D World (D-059).
 *
 * Text needs a 2D canvas. The browser factory draws each label into its own
 * canvas and hands three.js a CanvasTexture; the null factory produces plain
 * Object3Ds carrying `userData.text`, so builders stay testable in node where
 * there is no `document`. The layout maths is pure and shared by both paths.
 */

/** Rounded where the platform has it; every stack ends in a safe sans. */
export const LABEL_FONT_FAMILY =
  'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif';

/**
 * Type treatments. `display` is heavy and tight (the STRK20 headings), `mono`
 * is for uppercase captions, `sans` is a plain geometric sans (avnu), and
 * `rounded` is the cosy default.
 */
export type LabelFont = 'rounded' | 'sans' | 'display' | 'mono';

export const LABEL_FONTS: Readonly<Record<LabelFont, { readonly family: string; readonly weight: number }>> =
  Object.freeze({
    rounded: { family: LABEL_FONT_FAMILY, weight: 700 },
    sans: { family: '"Inter", "Helvetica Neue", Arial, system-ui, sans-serif', weight: 700 },
    display: { family: '"Inter Tight", "Helvetica Neue", "Arial Black", Arial, system-ui, sans-serif', weight: 900 },
    mono: { family: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace', weight: 600 },
  });

/**
 * Optional sign styling on top of the shared `SignOptions`. Builders build
 * these as typed values (not inline literals), so they still satisfy the
 * `LabelFactory` contract; factories that do not know a field ignore it.
 */
export interface SignStyleOptions extends SignOptions {
  /** CSS colours for a top-to-bottom gradient on the first line; overrides `foreground` there. */
  readonly gradient?: readonly string[];
  /** Corner radius as a fraction of the board height: 0 square, 0.5 a pill. */
  readonly cornerRadius?: number;
  /** Border width as a fraction of the board height; 0 draws none. */
  readonly borderWidth?: number;
  /** The inset enamel hairline; on by default. */
  readonly hairline?: boolean;
  readonly titleFont?: LabelFont;
  readonly subtitleFont?: LabelFont;
  /** CSS font weight, overriding the face's own (NEAR's regular 400, STRK20's 900). */
  readonly titleWeight?: number;
  readonly subtitleWeight?: number;
  /** Letter spacing in em; negative is tight. */
  readonly titleTracking?: number;
  readonly subtitleTracking?: number;
  /** Colour of the lines after the first; defaults to `foreground`. */
  readonly subtitleColor?: string;
  readonly uppercase?: boolean;
  /** For lowercase wordmarks (avnu); `uppercase` wins if both are set. */
  readonly lowercase?: boolean;
}

/** Optional floating-label styling on top of the shared `FloatingLabelOptions`. */
export interface FloatingStyleOptions extends FloatingLabelOptions {
  readonly font?: LabelFont;
  /** Corner radius as a fraction of the label height; defaults to a pill. */
  readonly cornerRadius?: number;
  /** CSS stroke colour for a thin border; none by default. */
  readonly border?: string;
  readonly tracking?: number;
  readonly uppercase?: boolean;
}

/** Canvas pixels per world unit on a facade sign, before devicePixelRatio. */
export const SIGN_PIXELS_PER_UNIT = 128;
/** Floating label glyph size in CSS pixels, before devicePixelRatio. */
export const FLOATING_FONT_PX = 44;
/** Largest canvas edge; bigger boards are rendered at a lower density. */
export const MAX_LABEL_CANVAS = 2048;

const SUBTITLE_SCALE = 0.6;
const LINE_GAP = 1.2;

/** Width in pixels of `text` at `fontPx`; `line` lets title and subtitle use different faces. */
export type MeasureText = (text: string, fontPx: number, line?: number) => number;

/** Split on newlines; always at least one (possibly empty) line. */
export function splitLabelLines(text: string): string[] {
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim());
  return lines.length > 0 ? lines : [''];
}

export interface SignLineLayout {
  readonly text: string;
  readonly fontPx: number;
  /** Vertical centre of the line in canvas pixels (textBaseline 'middle'). */
  readonly y: number;
}

/**
 * Fit a sign's lines into a pixel box. The first line is the title; later
 * lines are a smaller subtitle, which is how 'BANK\nSHIELD / UNSHIELD' reads
 * at a glance from the street.
 */
export function layoutSignText(
  lines: readonly string[],
  measure: MeasureText,
  box: { readonly width: number; readonly height: number; readonly padding: number },
): SignLineLayout[] {
  const list = lines.length > 0 ? lines : [''];
  const scales = list.map((_, index) => (list.length > 1 && index > 0 ? SUBTITLE_SCALE : 1));
  const innerWidth = Math.max(1, box.width - box.padding * 2);
  const innerHeight = Math.max(1, box.height - box.padding * 2);
  const scaleSum = scales.reduce((sum, scale) => sum + scale * LINE_GAP, 0);
  let fontPx = innerHeight / scaleSum;
  // Text width is close to linear in font size; a few passes absorb rounding.
  for (let pass = 0; pass < 3; pass++) {
    let fit = fontPx;
    list.forEach((line, index) => {
      const width = measure(line, fontPx * scales[index]!, index);
      if (width > innerWidth) fit = Math.min(fit, (fontPx * innerWidth) / width);
    });
    if (fit >= fontPx) break;
    fontPx = fit;
  }
  const heights = scales.map((scale) => scale * fontPx * LINE_GAP);
  const total = heights.reduce((sum, height) => sum + height, 0);
  let cursor = (box.height - total) / 2;
  return list.map((text, index) => {
    const height = heights[index]!;
    const y = cursor + height / 2;
    cursor += height;
    return { text, fontPx: Math.max(1, Math.floor(fontPx * scales[index]!)), y };
  });
}

export interface FloatingLabelLayout {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly fontPx: number;
  readonly linePx: number;
  /** Line centres in canvas pixels. */
  readonly baselines: readonly number[];
  /** Sprite size in world units: the height is `lines * lineHeight` plus padding. */
  readonly worldWidth: number;
  readonly worldHeight: number;
}

/** Size a camera-facing label from its text metrics. */
export function layoutFloatingLabel(
  lines: readonly string[],
  measure: MeasureText,
  options: { readonly fontPx: number; readonly lineHeight: number },
): FloatingLabelLayout {
  const list = lines.length > 0 ? lines : [''];
  const fontPx = Math.max(4, Math.round(options.fontPx));
  const linePx = Math.ceil(fontPx * 1.25);
  const padX = Math.ceil(fontPx * 0.55);
  const padY = Math.ceil(fontPx * 0.3);
  const textWidth = Math.max(fontPx, ...list.map((line, index) => measure(line, fontPx, index)));
  const canvasWidth = Math.min(MAX_LABEL_CANVAS, Math.ceil(textWidth + padX * 2));
  const canvasHeight = Math.min(MAX_LABEL_CANVAS, linePx * list.length + padY * 2);
  const unitsPerPixel = positive(options.lineHeight, 0.32) / linePx;
  return {
    canvasWidth,
    canvasHeight,
    fontPx,
    linePx,
    baselines: list.map((_, index) => padY + linePx * (index + 0.5)),
    worldWidth: canvasWidth * unitsPerPixel,
    worldHeight: canvasHeight * unitsPerPixel,
  };
}

/** Canvas pixel size for a sign board, capped so huge boards stay affordable. */
export function signCanvasSize(
  width: number,
  height: number,
  pixelRatio: number,
): { readonly width: number; readonly height: number } {
  const density = SIGN_PIXELS_PER_UNIT * clampRatio(pixelRatio);
  let w = Math.round(positive(width, 2) * density);
  let h = Math.round(positive(height, 0.8) * density);
  const longest = Math.max(w, h);
  if (longest > MAX_LABEL_CANVAS) {
    const k = MAX_LABEL_CANVAS / longest;
    w = Math.round(w * k);
    h = Math.round(h * k);
  }
  return { width: Math.max(2, w), height: Math.max(2, h) };
}

// ---------------------------------------------------------------------------
// Browser factory
// ---------------------------------------------------------------------------

/**
 * Canvas-backed labels. `sign` is a textured plane facing +Z centred on its
 * origin; `floating` is a Sprite anchored at its bottom centre. Canvases are
 * sized for the device pixel ratio so text stays crisp on HiDPI screens.
 */
export function createCanvasLabelFactory(doc: Document): LabelFactory {
  const pixelRatio = clampRatio(doc.defaultView?.devicePixelRatio ?? 1);
  return {
    sign(text, options) {
      return createCanvasSign(doc, pixelRatio, text, options) ?? nullLabel('sign', text, options);
    },
    floating(text, options = {}) {
      return (
        createCanvasFloating(doc, pixelRatio, text, options) ?? nullLabel('floating', text, options)
      );
    },
  };
}

function createCanvasSign(
  doc: Document,
  pixelRatio: number,
  text: string,
  options: SignOptions,
): TextLabel | null {
  const canvas = doc.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;
  const size = signCanvasSize(options.width, options.height, pixelRatio);
  canvas.width = size.width;
  canvas.height = size.height;

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // Signs are read at the camera's ~50 degree pitch; anisotropy keeps them sharp.
  texture.anisotropy = 4;
  const material = new MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false });
  const geometry = new PlaneGeometry(positive(options.width, 2), positive(options.height, 0.8));
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sign';
  mesh.userData['kind'] = 'sign';

  let current = String(text);
  let disposed = false;
  const draw = (): void => {
    drawSign(context, canvas.width, canvas.height, current, options as SignStyleOptions);
    mesh.userData['text'] = current;
    texture.needsUpdate = true;
  };
  draw();

  return {
    object: mesh,
    setText(next) {
      if (disposed) return;
      const value = String(next);
      if (value === current) return;
      current = value;
      draw();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}

function createCanvasFloating(
  doc: Document,
  pixelRatio: number,
  text: string,
  options: FloatingLabelOptions,
): TextLabel | null {
  const canvas = doc.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;
  const fontPx = Math.round(FLOATING_FONT_PX * pixelRatio);
  const lineHeight = positive(options.lineHeight, 0.32);
  const material = new SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false });
  const geometry = spriteQuadGeometry();
  const sprite = new Sprite(material);
  // Never draw with three's module-level sprite geometry: every renderer that
  // draws it adds a dispose listener renderer.dispose() never removes, so a
  // shared quad would pin each dead World's renderer for the page's lifetime.
  sprite.geometry = geometry;
  sprite.name = 'floating-label';
  sprite.center.set(0.5, 0);
  sprite.userData['kind'] = 'floating';

  let texture: CanvasTexture | null = null;
  let current = String(text);
  let disposed = false;
  const style = options as FloatingStyleOptions;
  const render = (): void => {
    const lines = splitLabelLines(style.uppercase ? current.toUpperCase() : current);
    const measure: MeasureText = (line, px) => {
      context.font = fontString(style.font ?? 'rounded', px, style.font ? undefined : 600);
      setTracking(context, style.tracking ?? 0);
      return context.measureText(line).width;
    };
    const layout = layoutFloatingLabel(lines, measure, { fontPx, lineHeight });
    const resized = canvas.width !== layout.canvasWidth || canvas.height !== layout.canvasHeight;
    if (resized) {
      canvas.width = layout.canvasWidth;
      canvas.height = layout.canvasHeight;
    }
    drawFloating(context, layout, lines, style);
    if (!texture || resized) {
      // GPU texture storage is immutable once uploaded: a new size needs a new texture.
      const previous = texture;
      texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      material.map = texture;
      previous?.dispose();
    }
    texture.needsUpdate = true;
    sprite.scale.set(layout.worldWidth, layout.worldHeight, 1);
    sprite.userData['text'] = current;
  };
  render();

  return {
    object: sprite,
    setText(next) {
      if (disposed) return;
      const value = String(next);
      if (value === current) return;
      current = value;
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sprite.removeFromParent();
      geometry.dispose();
      material.dispose();
      texture?.dispose();
      texture = null;
    },
  };
}

/** The sprite quad (three's own layout), one per label so it can be disposed. */
function spriteQuadGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  return geometry;
}

function fontString(font: LabelFont, px: number, weight?: number): string {
  const face = LABEL_FONTS[font] ?? LABEL_FONTS.rounded;
  return `${weight ?? face.weight} ${Math.max(1, Math.round(px))}px ${face.family}`;
}

/** Canvas letter spacing where supported; older engines simply ignore it. */
function setTracking(context: CanvasRenderingContext2D, em: number): void {
  const target = context as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in target) target.letterSpacing = `${em}em`;
}

function signFace(options: SignStyleOptions, line: number): { font: LabelFont; tracking: number; weight?: number } {
  return line === 0
    ? { font: options.titleFont ?? 'rounded', tracking: options.titleTracking ?? 0, weight: fontWeight(options.titleWeight) }
    : {
        font: options.subtitleFont ?? options.titleFont ?? 'rounded',
        tracking: options.subtitleTracking ?? 0,
        weight: fontWeight(options.subtitleWeight),
      };
}

/** A CSS weight from 100 to 900 in steps of 100, or none to keep the face's. */
function fontWeight(weight: number | undefined): number | undefined {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return undefined;
  return Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
}

/** The sign's text in the case its style asks for. */
export function signCase(text: string, options: Pick<SignStyleOptions, 'uppercase' | 'lowercase'>): string {
  if (options.uppercase) return text.toUpperCase();
  if (options.lowercase) return text.toLowerCase();
  return text;
}

function drawSign(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  options: SignStyleOptions,
): void {
  context.clearRect(0, 0, width, height);
  const borderFraction = options.borderWidth ?? 0.05;
  const border = borderFraction > 0 ? Math.max(1, height * borderFraction) : 0;
  const radius = Math.min(0.5, Math.max(0, options.cornerRadius ?? 0.16)) * height;
  roundedRect(context, border / 2, border / 2, width - border, height - border, radius);
  context.fillStyle = options.background ?? '#f4ecd8';
  context.fill();
  if (border > 0) {
    context.lineWidth = border;
    context.strokeStyle = options.accent ?? '#c9982f';
    context.stroke();
  }
  if (options.hairline !== false) {
    // A hairline inset gives the board an enamel-plaque edge.
    const unit = Math.max(2, height * 0.05);
    const inset = unit * 1.9;
    roundedRect(context, inset, inset, width - inset * 2, height - inset * 2, radius * 0.7);
    context.lineWidth = Math.max(1, unit * 0.35);
    context.strokeStyle = options.accent ?? '#c9982f';
    context.globalAlpha = 0.45;
    context.stroke();
    context.globalAlpha = 1;
  }

  const lines = splitLabelLines(signCase(text, options));
  const layout = layoutSignText(
    lines,
    (line, px, index = 0) => {
      const face = signFace(options, index);
      context.font = fontString(face.font, px, face.weight);
      setTracking(context, face.tracking);
      return context.measureText(line).width;
    },
    { width, height, padding: Math.max(2, height * 0.05) * 2.6 },
  );
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  layout.forEach((line, index) => {
    const face = signFace(options, index);
    context.font = fontString(face.font, line.fontPx, face.weight);
    setTracking(context, face.tracking);
    if (index === 0 && options.gradient && options.gradient.length > 0) {
      const gradient = context.createLinearGradient(0, line.y - line.fontPx * 0.5, 0, line.y + line.fontPx * 0.5);
      const stops = options.gradient;
      stops.forEach((stop, i) => gradient.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), stop));
      context.fillStyle = gradient;
    } else {
      context.fillStyle = index > 0 && options.subtitleColor ? options.subtitleColor : options.foreground ?? '#3b2a14';
    }
    context.fillText(line.text, width / 2, line.y);
  });
  setTracking(context, 0);
}

function drawFloating(
  context: CanvasRenderingContext2D,
  layout: FloatingLabelLayout,
  lines: readonly string[],
  options: FloatingStyleOptions,
): void {
  const { canvasWidth: width, canvasHeight: height } = layout;
  context.clearRect(0, 0, width, height);
  const radius =
    options.cornerRadius !== undefined
      ? Math.min(0.5, Math.max(0, options.cornerRadius)) * height
      : Math.min(height / 2, layout.linePx * 0.55);
  roundedRect(context, 1, 1, width - 2, height - 2, radius);
  context.fillStyle = options.background ?? 'rgba(26,22,30,0.8)';
  context.fill();
  if (options.border) {
    context.lineWidth = Math.max(1, layout.fontPx * 0.06);
    context.strokeStyle = options.border;
    context.stroke();
  }
  context.fillStyle = options.foreground ?? '#fff4dc';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = fontString(options.font ?? 'rounded', layout.fontPx, options.font ? undefined : 600);
  setTracking(context, options.tracking ?? 0);
  lines.forEach((line, index) => {
    context.fillText(line, width / 2, layout.baselines[index] ?? height / 2);
  });
  setTracking(context, 0);
}

/** arcTo paths work everywhere `roundRect` does not. */
function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.arcTo(x + width, y, x + width, y + r, r);
  context.lineTo(x + width, y + height - r);
  context.arcTo(x + width, y + height, x + width - r, y + height, r);
  context.lineTo(x + r, y + height);
  context.arcTo(x, y + height, x, y + height - r, r);
  context.lineTo(x, y + r);
  context.arcTo(x, y, x + r, y, r);
  context.closePath();
}

// ---------------------------------------------------------------------------
// Node / test factory
// ---------------------------------------------------------------------------

/**
 * Labels without a canvas: an Object3D whose `userData.text` tracks the text.
 * Also the browser fallback when a 2D context is unavailable, so a missing
 * canvas degrades to unlabeled geometry instead of a crashed World.
 */
export function createNullLabelFactory(): LabelFactory {
  return {
    sign: (text, options) => nullLabel('sign', text, options),
    floating: (text, options = {}) => nullLabel('floating', text, options),
  };
}

function nullLabel(
  kind: 'sign' | 'floating',
  text: string,
  options: SignOptions | FloatingLabelOptions,
): TextLabel {
  const object = new Object3D();
  object.name = kind === 'sign' ? 'sign' : 'floating-label';
  object.userData['kind'] = kind;
  object.userData['text'] = String(text);
  object.userData['options'] = Object.freeze({ ...options });
  object.userData['disposed'] = false;
  let disposed = false;
  return {
    object,
    setText(next) {
      if (disposed) return;
      object.userData['text'] = String(next);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      object.userData['disposed'] = true;
      object.removeFromParent();
    },
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(2, Math.max(1, ratio)) : 1;
}
