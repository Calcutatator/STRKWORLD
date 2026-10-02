/**
 * The STRKWORLD wordmark (docs/brand, Direction A "Built from blocks"): the
 * name set in Press Start 2P's 8px bitmaps, each pixel a cube, lit with the
 * World's sun and hemisphere colours. See README.md for the exact command.
 *
 * The rejected directions (B, an arcade pixel title; C, toy-block tiles) were
 * explored in this file and dropped from it once A was approved; the decision
 * log records them.
 */
import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { HEMISPHERE_GROUND, HEMISPHERE_SKY, SUN_COLOR } from '../../src/three/lighting.js';

const q = new URLSearchParams(location.search);
const log = (s: string) => {
  (document.getElementById('log') as HTMLElement).textContent += s + '\n';
  console.log(s);
};

interface Mask {
  w: number;
  h: number;
  on: (x: number, y: number) => boolean;
}

async function fontsReady(fams: string[]): Promise<void> {
  await Promise.all(fams.map((f) => document.fonts.load(f)));
}

async function save(c: HTMLCanvasElement, name: string): Promise<void> {
  await fetch(`/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: c.toDataURL('image/png') });
  log('saved ' + name);
}

const inked = (d: Uint8ClampedArray, i: number) => (d[i * 4 + 3] ?? 0) > 127;

/** Text -> binary bitmap at a small pixel size, trimmed to its ink. */
function bitmap(text: string, font: string, px: number, track = 1): Mask {
  const c = document.createElement('canvas');
  c.width = 4000;
  c.height = px * 3;
  const g = c.getContext('2d')!;
  g.font = font.replace('PX', String(px));
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#000';
  let x = 2;
  for (const ch of text) {
    g.fillText(ch, x, px * 2);
    x += Math.round(g.measureText(ch).width) + track;
  }
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let xx = 0; xx < c.width; xx++) {
    if (inked(d, y * c.width + xx)) { x0 = Math.min(x0, xx); y0 = Math.min(y0, y); x1 = Math.max(x1, xx); y1 = Math.max(y1, y); }
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  return { w, h, on: (xx, yy) => xx >= 0 && yy >= 0 && xx < w && yy < h && inked(d, (yy + y0) * c.width + xx + x0) };
}

/** Like bitmap(), but each letter is trimmed to its own ink and set `gap` pixels apart (optical, not font, spacing). */
function bitmapTight(text: string, font: string, px: number, gap = 1): Mask {
  const f = font.replace('PX', String(px));
  const h = bitmap(text, font, px, 0).h;
  // The line's top inked row, with every glyph drawn at the same baseline.
  const topRow = (() => {
    const cc = document.createElement('canvas');
    cc.width = 4000;
    cc.height = px * 3;
    const gg = cc.getContext('2d')!;
    gg.font = f;
    gg.textBaseline = 'alphabetic';
    gg.fillText(text, px, px * 2);
    const d = gg.getImageData(0, 0, cc.width, cc.height).data;
    for (let y = 0; y < cc.height; y++) for (let x = 0; x < cc.width; x++) if (inked(d, y * cc.width + x)) return y;
    return 0;
  })();
  const cols: { w: number; x: number; on: (x: number, y: number) => boolean }[] = [];
  let at = 0;
  for (const ch of text) {
    const cc = document.createElement('canvas');
    cc.width = px * 3;
    cc.height = px * 3;
    const gg = cc.getContext('2d')!;
    gg.font = f;
    gg.textBaseline = 'alphabetic';
    gg.fillText(ch, px, px * 2);
    const d = gg.getImageData(0, 0, cc.width, cc.height).data;
    let x0 = 1e9, x1 = -1;
    for (let y = 0; y < cc.height; y++) for (let x = 0; x < cc.width; x++) if (inked(d, y * cc.width + x)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    const w = x1 - x0 + 1;
    cols.push({ w, x: at, on: (x, y) => inked(d, (y + topRow) * cc.width + x + x0) });
    at += w + gap;
  }
  const w = at - gap;
  return {
    w,
    h,
    on: (xx, yy) => {
      if (yy < 0 || yy >= h) return false;
      for (const cl of cols) if (xx >= cl.x && xx < cl.x + cl.w) return cl.on(xx - cl.x, yy);
      return false;
    },
  };
}

/** Stack lines, each centred, `gap` pixels apart, into one mask. */
function stack(lines: Mask[], gap: number): Mask & { tops: number[] } {
  const w = Math.max(...lines.map((l) => l.w));
  const h = lines.reduce((a, l) => a + l.h, 0) + gap * (lines.length - 1);
  const placed: { l: Mask; ox: number; oy: number }[] = [];
  let y = 0;
  for (const l of lines) {
    placed.push({ l, ox: Math.floor((w - l.w) / 2), oy: y });
    y += l.h + gap;
  }
  return { w, h, tops: placed.map((p) => p.oy), on: (x, yy) => placed.some(({ l, ox, oy }) => l.on(x - ox, yy - oy)) };
}

/** The mask grown by `r` pixels (square), on a canvas padded by `pad`. */
function dilate(m: Mask, r: number, pad: number): Uint8Array {
  const W = m.w + pad * 2, H = m.h + pad * 2, a = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let hit = false;
    for (let dy = -r; dy <= r && !hit; dy++) for (let dx = -r; dx <= r && !hit; dx++) if (m.on(x - pad + dx, y - pad + dy)) hit = true;
    a[y * W + x] = hit ? 1 : 0;
  }
  return a;
}

/** Direction A: the wordmark built from cubes, lit like the street. */
async function voxel(): Promise<void> {
  await fontsReady(['8px "Press Start 2P"']);
  const lines = (q.get('text') ?? 'STRK|WORLD')
    .split('|')
    .map((t) => bitmapTight(t, '8px "Press Start 2P"', 8, Number(q.get('gap') ?? 1)));
  const m = stack(lines, 2);
  const W = Number(q.get('w') ?? 2400), H = Number(q.get('h') ?? 1500);
  const r = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(W, H);
  r.outputColorSpace = SRGBColorSpace;
  r.toneMapping = NoToneMapping;
  r.shadowMap.enabled = true;
  r.setClearColor(0, 0);
  document.body.appendChild(r.domElement);
  const scene = new Scene();
  const cells: [number, number, number, number][] = []; // x, y, z, colour
  // Front faces: gold at the top of each line to ember at the bottom.
  const grad = [0xffd23a, 0xffbb22, 0xffa01a, 0xff8418, 0xf56a16, 0xe8501a];
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.on(x, y)) {
    let li = 0;
    m.tops.forEach((top, i) => { if (y >= top) li = i; });
    const t = (y - (m.tops[li] ?? 0)) / Math.max(1, (lines[li]?.h ?? 1) - 1);
    cells.push([x, -y, 0, grad[Math.min(grad.length - 1, Math.round(t * (grad.length - 1)))] ?? 0xe8501a]);
    cells.push([x, -y, -1, 0xb8400c]); // the drop
  }
  // A dark outline shell one cube out, set back.
  const ring = dilate(m, 1, 1);
  for (let y = 0; y < m.h + 2; y++) for (let x = 0; x < m.w + 2; x++) {
    if (ring[y * (m.w + 2) + x] && !m.on(x - 1, y - 1)) {
      cells.push([x - 1, -(y - 1), -0.6, 0x24120a]);
      cells.push([x - 1, -(y - 1), -1.6, 0x24120a]);
    }
  }
  const inst = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ roughness: 0.8, metalness: 0, flatShading: true }), cells.length);
  const M = new Matrix4(), col = new Color();
  cells.forEach(([x, y, z, c], i) => {
    M.makeTranslation(x - m.w / 2, y + m.h / 2, z);
    inst.setMatrixAt(i, M);
    inst.setColorAt(i, col.setHex(c));
  });
  inst.castShadow = true;
  inst.receiveShadow = true;
  scene.add(inst);
  scene.add(new HemisphereLight(HEMISPHERE_SKY, HEMISPHERE_GROUND, 0.9));
  const sun = new DirectionalLight(SUN_COLOR, 1.9);
  sun.position.set(-14, 24, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -40; sc.right = 40; sc.top = 30; sc.bottom = -30; sc.far = 120;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  const fill = new DirectionalLight(0xfff0d8, 0.6);
  fill.position.set(10, -4, 20);
  scene.add(fill);
  const cam = new PerspectiveCamera(Number(q.get('fov') ?? 24), W / H, 1, 500);
  const yaw = (Number(q.get('yaw') ?? -14) * Math.PI) / 180;
  const pitch = (Number(q.get('pitch') ?? -10) * Math.PI) / 180;
  const dist = Number(q.get('dist') ?? 95);
  cam.position.set(Math.sin(yaw) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist);
  cam.lookAt(0, -1, 0);
  r.render(scene, cam);
  await save(r.domElement, q.get('name') ?? 'wordmark.png');
}

const mode = q.get('mode') ?? 'voxel';
(mode === 'voxel' ? voxel() : Promise.reject(new Error(`unknown mode "${mode}"; the only mode is voxel`))).then(
  () => log('DONE'),
  (e: unknown) => log('ERR ' + ((e as Error)?.stack ?? String(e))),
);
