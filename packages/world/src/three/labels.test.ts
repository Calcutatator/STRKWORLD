import { describe, expect, it, vi } from 'vitest';
import { CanvasTexture, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, SRGBColorSpace, Sprite, SpriteMaterial } from 'three';
import {
  MAX_LABEL_CANVAS,
  SIGN_PIXELS_PER_UNIT,
  createCanvasLabelFactory,
  createNullLabelFactory,
  layoutFloatingLabel,
  layoutSignText,
  signCanvasSize,
  splitLabelLines,
  type MeasureText,
} from './labels.js';

/** Roughly a bold sans: 0.6 em per glyph. */
const measure: MeasureText = (text, px) => text.length * px * 0.6;

describe('label text layout', () => {
  it('splits on newlines and always yields a line', () => {
    expect(splitLabelLines('BANK\nSHIELD / UNSHIELD')).toEqual(['BANK', 'SHIELD / UNSHIELD']);
    expect(splitLabelLines('A\r\n B ')).toEqual(['A', 'B']);
    expect(splitLabelLines('')).toEqual(['']);
  });

  it('sets a sign title larger than its subtitle, centred, and inside the board', () => {
    const box = { width: 600, height: 220, padding: 20 };
    const lines = layoutSignText(['BANK', 'SHIELD / UNSHIELD'], measure, box);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.fontPx).toBeGreaterThan(lines[1]!.fontPx);
    expect(lines[0]!.y).toBeLessThan(lines[1]!.y);
    for (const line of lines) {
      expect(measure(line.text, line.fontPx)).toBeLessThanOrEqual(box.width - box.padding * 2 + 1);
      expect(line.y).toBeGreaterThan(0);
      expect(line.y).toBeLessThan(box.height);
    }
    const middle = (lines[0]!.y + lines[1]!.y) / 2;
    expect(Math.abs(middle - box.height / 2)).toBeLessThan(box.height * 0.2);
  });

  it('shrinks a long title to fit the board width', () => {
    const box = { width: 400, height: 200, padding: 10 };
    const short = layoutSignText(['VAULT'], measure, box);
    const long = layoutSignText(['A VERY LONG BUILDING NAME'], measure, box);
    expect(long[0]!.fontPx).toBeLessThan(short[0]!.fontPx);
    expect(measure(long[0]!.text, long[0]!.fontPx)).toBeLessThanOrEqual(380);
  });

  it('sizes a floating label from its text, keeping the canvas aspect', () => {
    const one = layoutFloatingLabel(['SWAP'], measure, { fontPx: 44, lineHeight: 0.3 });
    const wide = layoutFloatingLabel(['SHIELD / UNSHIELD'], measure, { fontPx: 44, lineHeight: 0.3 });
    const two = layoutFloatingLabel(['SWAP', 'CLOSED'], measure, { fontPx: 44, lineHeight: 0.3 });
    expect(wide.worldWidth).toBeGreaterThan(one.worldWidth);
    expect(wide.worldHeight).toBeCloseTo(one.worldHeight);
    expect(two.worldHeight).toBeGreaterThan(one.worldHeight);
    // One line is lineHeight tall plus padding.
    expect(one.worldHeight).toBeGreaterThan(0.3);
    expect(one.worldHeight).toBeLessThan(0.3 * 1.8);
    for (const layout of [one, wide, two]) {
      expect(layout.worldWidth / layout.worldHeight).toBeCloseTo(layout.canvasWidth / layout.canvasHeight);
      for (const baseline of layout.baselines) {
        expect(baseline).toBeGreaterThan(0);
        expect(baseline).toBeLessThan(layout.canvasHeight);
      }
    }
  });

  it('renders signs at device pixel density, capped for huge boards', () => {
    expect(signCanvasSize(2, 1, 1)).toEqual({ width: 2 * SIGN_PIXELS_PER_UNIT, height: SIGN_PIXELS_PER_UNIT });
    expect(signCanvasSize(2, 1, 2)).toEqual({ width: 4 * SIGN_PIXELS_PER_UNIT, height: 2 * SIGN_PIXELS_PER_UNIT });
    expect(signCanvasSize(2, 1, 5)).toEqual(signCanvasSize(2, 1, 2));
    const huge = signCanvasSize(40, 4, 2);
    expect(Math.max(huge.width, huge.height)).toBeLessThanOrEqual(MAX_LABEL_CANVAS);
    expect(huge.width / huge.height).toBeCloseTo(10, 1);
  });
});

describe('createNullLabelFactory', () => {
  it('produces plain objects that carry their text', () => {
    const labels = createNullLabelFactory();
    const sign = labels.sign('BANK\nSHIELD', { width: 2, height: 0.8, background: '#fff' });
    const floating = labels.floating('SWAP', { lineHeight: 0.3 });
    expect(sign.object).toBeInstanceOf(Object3D);
    expect(sign.object.userData).toMatchObject({ kind: 'sign', text: 'BANK\nSHIELD' });
    expect(sign.object.userData['options']).toMatchObject({ width: 2, height: 0.8, background: '#fff' });
    expect(floating.object.userData).toMatchObject({ kind: 'floating', text: 'SWAP' });
    floating.setText('SWAP 2');
    expect(floating.object.userData['text']).toBe('SWAP 2');
  });

  it('disposes idempotently and ignores late text', () => {
    const labels = createNullLabelFactory();
    const label = labels.floating('A');
    const parent = new Object3D();
    parent.add(label.object);
    label.dispose();
    label.dispose();
    label.setText('B');
    expect(parent.children).toHaveLength(0);
    expect(label.object.userData).toMatchObject({ text: 'A', disposed: true });
  });
});

describe('createCanvasLabelFactory', () => {
  it('draws a sign into a DPR-sized canvas on a +Z plane with an sRGB texture', () => {
    const { doc, canvases } = fakeDocument({ ratio: 2 });
    const sign = createCanvasLabelFactory(doc).sign('BANK\nSHIELD / UNSHIELD', {
      width: 2.1,
      height: 0.8,
      background: '#f8f0dc',
      foreground: '#5b3a14',
      accent: '#c9982f',
    });
    const canvas = canvases[0]!;
    expect({ width: canvas.width, height: canvas.height }).toEqual(signCanvasSize(2.1, 0.8, 2));
    expect(canvas.drawn).toEqual(['BANK', 'SHIELD / UNSHIELD']);
    const mesh = sign.object as Mesh;
    expect(mesh).toBeInstanceOf(Mesh);
    const geometry = mesh.geometry as PlaneGeometry;
    expect(geometry.parameters).toMatchObject({ width: 2.1, height: 0.8 });
    const material = mesh.material as MeshBasicMaterial;
    const texture = material.map as CanvasTexture;
    expect(texture).toBeInstanceOf(CanvasTexture);
    expect(texture.colorSpace).toBe(SRGBColorSpace);
    expect(texture.image).toBe(canvas);
    const version = texture.version;

    sign.setText('VAULT\nCOMING SOON');
    expect(canvas.drawn.slice(-2)).toEqual(['VAULT', 'COMING SOON']);
    expect(texture.version).toBeGreaterThan(version);
    expect(mesh.userData['text']).toBe('VAULT\nCOMING SOON');

    const spies = [vi.spyOn(geometry, 'dispose'), vi.spyOn(material, 'dispose'), vi.spyOn(texture, 'dispose')];
    const parent = new Object3D();
    parent.add(mesh);
    sign.dispose();
    sign.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(parent.children).toHaveLength(0);
  });

  it('anchors floating labels at the bottom centre and resizes them with their text', () => {
    const { doc, canvases } = fakeDocument({ ratio: 1 });
    const label = createCanvasLabelFactory(doc).floating('SWAP', { lineHeight: 0.3 });
    const sprite = label.object as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.center.toArray()).toEqual([0.5, 0]);
    const material = sprite.material as SpriteMaterial;
    const first = material.map as CanvasTexture;
    expect(first.colorSpace).toBe(SRGBColorSpace);
    expect(sprite.scale.y).toBeGreaterThan(0.3);
    const narrow = sprite.scale.x;
    const dispose = vi.spyOn(first, 'dispose');

    label.setText('SHIELD / UNSHIELD');
    expect(sprite.scale.x).toBeGreaterThan(narrow);
    // A new canvas size needs a new GPU texture; the old one is released.
    expect(material.map).not.toBe(first);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(canvases[0]!.drawn.at(-1)).toBe('SHIELD / UNSHIELD');

    const second = material.map as CanvasTexture;
    const secondDispose = vi.spyOn(second, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    label.dispose();
    label.dispose();
    expect(secondDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
  });

  it('falls back to a plain labelled object when there is no 2D context', () => {
    const { doc } = fakeDocument({ noContext: true });
    const labels = createCanvasLabelFactory(doc);
    expect(labels.sign('BANK', { width: 2, height: 1 }).object.userData['text']).toBe('BANK');
    expect(labels.floating('SWAP').object.userData['text']).toBe('SWAP');
  });
});

interface FakeCanvas {
  width: number;
  height: number;
  readonly drawn: string[];
  getContext(kind: string): unknown;
}

function fakeDocument(options: { ratio?: number; noContext?: boolean } = {}) {
  const canvases: FakeCanvas[] = [];
  const doc = {
    defaultView: { devicePixelRatio: options.ratio ?? 1 },
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`unexpected element ${tag}`);
      const drawn: string[] = [];
      const context = {
        font: '10px sans-serif',
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        globalAlpha: 1,
        textAlign: 'start',
        textBaseline: 'alphabetic',
        measureText(text: string) {
          const px = Number(/(\d+(?:\.\d+)?)px/.exec(context.font)?.[1] ?? 10);
          return { width: text.length * px * 0.6 };
        },
        fillText(text: string) {
          drawn.push(text);
        },
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arcTo: vi.fn(),
        closePath: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
      };
      const canvas: FakeCanvas = {
        width: 300,
        height: 150,
        drawn,
        getContext: () => (options.noContext ? null : context),
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  return { doc: doc as unknown as Document, canvases };
}
