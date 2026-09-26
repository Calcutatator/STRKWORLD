import {
  CanvasTexture,
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

/** Canvas pixels per world unit on a facade sign, before devicePixelRatio. */
export const SIGN_PIXELS_PER_UNIT = 128;
/** Floating label glyph size in CSS pixels, before devicePixelRatio. */
export const FLOATING_FONT_PX = 44;
/** Largest canvas edge; bigger boards are rendered at a lower density. */
export const MAX_LABEL_CANVAS = 2048;

const SUBTITLE_SCALE = 0.6;
const LINE_GAP = 1.2;

export type MeasureText = (text: string, fontPx: number) => number;

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
      const width = measure(line, fontPx * scales[index]!);
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
  const textWidth = Math.max(fontPx, ...list.map((line) => measure(line, fontPx)));
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
    drawSign(context, canvas.width, canvas.height, current, options);
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
  const sprite = new Sprite(material);
  sprite.name = 'floating-label';
  sprite.center.set(0.5, 0);
  sprite.userData['kind'] = 'floating';

  let texture: CanvasTexture | null = null;
  let current = String(text);
  let disposed = false;
  const render = (): void => {
    const lines = splitLabelLines(current);
    const measure: MeasureText = (line, px) => {
      context.font = floatingFont(px);
      return context.measureText(line).width;
    };
    const layout = layoutFloatingLabel(lines, measure, { fontPx, lineHeight });
    const resized = canvas.width !== layout.canvasWidth || canvas.height !== layout.canvasHeight;
    if (resized) {
      canvas.width = layout.canvasWidth;
      canvas.height = layout.canvasHeight;
    }
    drawFloating(context, layout, lines, options);
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
      // Sprite geometry is shared by every three.js sprite; never dispose it.
      material.dispose();
      texture?.dispose();
      texture = null;
    },
  };
}

function signFont(px: number): string {
  return `700 ${Math.max(1, Math.round(px))}px ${LABEL_FONT_FAMILY}`;
}

function floatingFont(px: number): string {
  return `600 ${Math.max(1, Math.round(px))}px ${LABEL_FONT_FAMILY}`;
}

function drawSign(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  options: SignOptions,
): void {
  context.clearRect(0, 0, width, height);
  const border = Math.max(2, height * 0.05);
  const radius = Math.min(width, height) * 0.16;
  roundedRect(context, border / 2, border / 2, width - border, height - border, radius);
  context.fillStyle = options.background ?? '#f4ecd8';
  context.fill();
  context.lineWidth = border;
  context.strokeStyle = options.accent ?? '#c9982f';
  context.stroke();
  // A hairline inset gives the board an enamel-plaque edge.
  const inset = border * 1.9;
  roundedRect(context, inset, inset, width - inset * 2, height - inset * 2, radius * 0.7);
  context.lineWidth = Math.max(1, border * 0.35);
  context.globalAlpha = 0.45;
  context.stroke();
  context.globalAlpha = 1;

  const lines = splitLabelLines(text);
  const layout = layoutSignText(
    lines,
    (line, px) => {
      context.font = signFont(px);
      return context.measureText(line).width;
    },
    { width, height, padding: border * 2.6 },
  );
  context.fillStyle = options.foreground ?? '#3b2a14';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const line of layout) {
    context.font = signFont(line.fontPx);
    context.fillText(line.text, width / 2, line.y);
  }
}

function drawFloating(
  context: CanvasRenderingContext2D,
  layout: FloatingLabelLayout,
  lines: readonly string[],
  options: FloatingLabelOptions,
): void {
  const { canvasWidth: width, canvasHeight: height } = layout;
  context.clearRect(0, 0, width, height);
  const radius = Math.min(height / 2, layout.linePx * 0.55);
  roundedRect(context, 1, 1, width - 2, height - 2, radius);
  context.fillStyle = options.background ?? 'rgba(26,22,30,0.8)';
  context.fill();
  context.fillStyle = options.foreground ?? '#fff4dc';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = floatingFont(layout.fontPx);
  lines.forEach((line, index) => {
    context.fillText(line, width / 2, layout.baselines[index] ?? height / 2);
  });
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
