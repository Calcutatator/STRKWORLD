import { deflateSync, inflateSync } from 'node:zlib';
import { Color, DataUtils, Matrix3, Mesh, MeshStandardMaterial, Vector3, type Object3D } from 'three';
import { getDFGLUT } from 'three/src/renderers/shaders/DFGLUTData.js';
import {
  AVATAR_WALKER_CELL,
  AVATAR_WALKER_DENSITY,
  AVATAR_WALKER_FRAMES,
  AVATAR_WALKER_SPRITE,
  AVATAR_WALKER_STRIDE_MS,
} from '../src/avatar-walker.js';
import { createAvatarFigure } from '../src/three/avatar-figure.js';
import { CAMERA_PITCH, cameraPositionFor } from '../src/three/camera-rig.js';
import {
  HEMISPHERE_GROUND,
  HEMISPHERE_INTENSITY,
  HEMISPHERE_SKY,
  SHADOW_MAP_SIZE,
  SHADOW_NORMAL_BIAS,
  SHADOW_RADIUS,
  SHADOW_TEXEL,
  SUN_COLOR,
  SUN_INTENSITY,
  SUN_OFFSET,
  TONE_MAPPING_EXPOSURE,
} from '../src/three/lighting.js';

/**
 * The offline render behind `AVATAR_WALKER` (src/avatar-walker.ts): the
 * default figure walking towards the viewer, one PNG strip of square cells.
 *
 * It draws the real model through its real walk cycle, `createAvatarFigure`
 * driven by `update()` at the game's cadence, with a small software rasterizer
 * that shades the way the engine does (world-engine.ts): three r186's
 * MeshStandardMaterial under the scene's hemisphere and sun, the sun's
 * self-shadowing through the same shadow-map texel and PCF radius, ACES
 * filmic tone mapping and sRGB output. 4 x 4 samples a pixel stand in for the
 * engine's antialiasing. The background is transparent and a soft contact
 * shadow sits under the feet. The camera keeps the street camera's pitch and
 * distance, so the figure is seen as the game frames it, from the front.
 *
 * Deterministic: no clock, no randomness, no GPU. The same model and lighting
 * give the same pixels, which `avatar-walker.test.ts` checks against the
 * committed strip. When the figure, its walk or the lighting changes,
 * regenerate: `npm run render:walker --workspace=@strkworld/world`.
 */

export const AVATAR_WALKER_FILE = new URL('../assets/avatar-walker/walk.png', import.meta.url);

/** One cell's side in the file's pixels. */
export const WALKER_CELL_PX = AVATAR_WALKER_CELL * AVATAR_WALKER_DENSITY;
const SUPERSAMPLE = 4;

// Framing. The camera looks at FRAME_AIM_Y on the figure's axis from the
// street camera's pitch and distance, and the cell spans FRAME_HEIGHT world
// units there: the tallest stride and the contact shadow fit with a margin.
const FRAME_AIM_Y = 0.64;
const FRAME_HEIGHT = 1.62;
const STREET_CAMERA = cameraPositionFor({ x: 0, z: 0 });
/** Transparent pixels kept clear on every side of a cell. */
const EDGE_MARGIN_PX = 2;

// Contact shadow: a soft black ellipse on the ground under the feet, wide
// enough for the stride's reach, so it darkens whatever the strip sits on.
const CONTACT_RADIUS_X = 0.4;
const CONTACT_RADIUS_Z = 0.3;
const CONTACT_OPACITY = 0.42;

// Walk timing. The figure eases into its gait, so it walks whole strides first;
// a whole number of strides lands the first walking cell on the stride's start.
const WARM_UP_STRIDES = 4;
const WALKING = Object.freeze({ moving: true, sprinting: false });

// three r186 shading constants (lights_physical_pars_fragment, common).
const RECIPROCAL_PI = 1 / Math.PI;
const EPSILON = 1e-6;
const DIELECTRIC_F0 = 0.04;
const MIN_ROUGHNESS = 0.0525;
const VOGEL_SAMPLES = 5;
const GOLDEN_ANGLE = 2.399963229728653;
/** Rotations of the 5-tap disk averaged in place of the engine's per-pixel noise. */
const PCF_ROTATIONS = 8;

export interface WalkerStrip {
  /** Pixels, left to right: `cells` square cells of `height` pixels. */
  readonly width: number;
  readonly height: number;
  readonly cells: number;
  /** Row-major RGBA, straight (unpremultiplied) alpha. */
  readonly rgba: Uint8Array;
}

/** Render the whole strip: the standing cell, then one stride of walking. */
export function renderAvatarWalker(): WalkerStrip {
  const figure = createAvatarFigure(AVATAR_WALKER_SPRITE);
  const eyes = figure.object.getObjectByName('avatar-eyes');
  if (!eyes) throw new Error('avatar walker: the figure has no avatar-eyes mesh');
  const renderer = createFigureRenderer();
  const step = AVATAR_WALKER_STRIDE_MS / AVATAR_WALKER_FRAMES;
  const cells: Uint8Array[] = [];
  const capture = (): Uint8Array => {
    // A blink caught in a frame would flash on every loop.
    if (eyes.scale.y !== 1) throw new Error('avatar walker: a frame caught the figure blinking');
    return renderer(figure.object);
  };
  try {
    cells.push(capture());
    for (let i = 0; i < WARM_UP_STRIDES * AVATAR_WALKER_FRAMES; i += 1) figure.update(step, WALKING);
    for (let i = 0; i < AVATAR_WALKER_FRAMES; i += 1) {
      cells.push(capture());
      figure.update(step, WALKING);
    }
    // One step past the last cell must land back on the first walking cell, or
    // the loop hitches; this also proves the stride length matches the figure.
    const wrap = capture();
    const first = cells[1]!;
    if (maxChannelDifference(wrap, first) > 1) {
      throw new Error('avatar walker: the stride does not loop; AVATAR_WALKER_STRIDE_MS no longer matches the figure');
    }
  } finally {
    figure.dispose();
  }
  cells.forEach(assertEdgeMargin);
  return joinCells(cells);
}

// ---------------------------------------------------------------- one cell

/** Renders one figure pose to a square RGBA cell. */
export type FigureRenderer = (root: Object3D) => Uint8Array;

/**
 * Framing for `createFigureRenderer`. The defaults are the walker strip's; the
 * other values serve review renders (larger cells, close-ups, taller looks).
 */
export interface FigureFraming {
  /** One cell's side in pixels. */
  readonly cellPx?: number;
  /** The height on the figure's axis the camera looks at. */
  readonly aimY?: number;
  /** World units the cell spans vertically at the aim point. */
  readonly frameHeight?: number;
  /** Draw the soft contact shadow under the feet. */
  readonly contactShadow?: boolean;
}

/**
 * The walker's camera, sun and shading over a figure at the origin, seen from
 * the street camera's pitch and distance. Turn the figure (its root's yaw) to
 * see it from another side: the sun stays where the game puts it.
 */
export function createFigureRenderer(framing: FigureFraming = {}): FigureRenderer {
  const cellPx = framing.cellPx ?? WALKER_CELL_PX;
  const aimY = framing.aimY ?? FRAME_AIM_Y;
  const frameHeight = framing.frameHeight ?? FRAME_HEIGHT;
  const samples = cellPx * SUPERSAMPLE;
  const distance = Math.hypot(STREET_CAMERA.y - aimY, STREET_CAMERA.z);
  const aim = new Vector3(0, aimY, 0);
  const eye = new Vector3(0, Math.sin(CAMERA_PITCH), Math.cos(CAMERA_PITCH))
    .multiplyScalar(distance)
    .add(aim);
  const forward = aim.clone().sub(eye).normalize();
  const right = forward.clone().cross(new Vector3(0, 1, 0)).normalize();
  const up = right.clone().cross(forward);
  const tanHalf = frameHeight / 2 / distance;
  const camera: ViewCamera = { eye, forward, right, up, tanHalf, samples };
  const light = createSunLight();
  const shading = createShading();

  // One unit ray per sample, shared by every frame.
  const rays = new Float64Array(samples * samples * 3);
  for (let y = 0; y < samples; y += 1) {
    const ndcY = 1 - ((y + 0.5) / samples) * 2;
    for (let x = 0; x < samples; x += 1) {
      const ndcX = ((x + 0.5) / samples) * 2 - 1;
      const dx = forward.x + (right.x * ndcX + up.x * ndcY) * tanHalf;
      const dy = forward.y + (right.y * ndcX + up.y * ndcY) * tanHalf;
      const dz = forward.z + (right.z * ndcX + up.z * ndcY) * tanHalf;
      const length = Math.hypot(dx, dy, dz);
      const index = (y * samples + x) * 3;
      rays[index] = dx / length;
      rays[index + 1] = dy / length;
      rays[index + 2] = dz / length;
    }
  }
  const contact = framing.contactShadow === false
    ? new Float64Array(samples * samples)
    : contactShadow(camera, rays);

  return (root) => {
    const triangles = collectTriangles(root);
    const shadow = light.shadowMap(triangles);
    const { hit, depth } = rasterize(triangles, camera);
    const sampleRgb = new Float64Array(3);
    const out = new Uint8Array(cellPx * cellPx * 4);
    const point = new Vector3();
    const view = new Vector3();
    for (let py = 0; py < cellPx; py += 1) {
      for (let px = 0; px < cellPx; px += 1) {
        let red = 0;
        let green = 0;
        let blue = 0;
        let alpha = 0;
        for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
          for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
            const sample = (py * SUPERSAMPLE + sy) * samples + px * SUPERSAMPLE + sx;
            const triangle = hit[sample]!;
            if (triangle < 0) {
              // Only the contact shadow here: black at its opacity, premultiplied.
              alpha += contact[sample]!;
              continue;
            }
            const ray = sample * 3;
            view.set(rays[ray]!, rays[ray + 1]!, rays[ray + 2]!);
            // The sample's view depth back to a world point on its ray.
            point.copy(view).multiplyScalar(depth[sample]! / view.dot(forward)).add(eye);
            view.negate();
            const lit = light.visibility(shadow, triangles, triangle, point);
            shading(triangles, triangle, view, lit, sampleRgb);
            red += sampleRgb[0]!;
            green += sampleRgb[1]!;
            blue += sampleRgb[2]!;
            alpha += 1;
          }
        }
        const index = (py * cellPx + px) * 4;
        if (alpha <= 0) continue;
        out[index] = toByte(red / alpha);
        out[index + 1] = toByte(green / alpha);
        out[index + 2] = toByte(blue / alpha);
        out[index + 3] = toByte(alpha / (SUPERSAMPLE * SUPERSAMPLE));
      }
    }
    return out;
  };
}

function toByte(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

interface ViewCamera {
  readonly eye: Vector3;
  readonly forward: Vector3;
  readonly right: Vector3;
  readonly up: Vector3;
  /** tan(fov / 2); the cell is square. */
  readonly tanHalf: number;
  /** Samples along each side of the cell. */
  readonly samples: number;
}

/** The contact shadow's opacity per sample, where its ray meets the ground. */
function contactShadow(camera: ViewCamera, rays: Float64Array): Float64Array {
  const opacity = new Float64Array(camera.samples * camera.samples);
  for (let sample = 0; sample < opacity.length; sample += 1) {
    const dy = rays[sample * 3 + 1]!;
    if (dy >= 0) continue;
    const t = -camera.eye.y / dy;
    const gx = (camera.eye.x + rays[sample * 3]! * t) / CONTACT_RADIUS_X;
    const gz = (camera.eye.z + rays[sample * 3 + 2]! * t) / CONTACT_RADIUS_Z;
    const r = Math.hypot(gx, gz);
    if (r >= 1) continue;
    // Dark at the middle, easing out to nothing at the rim.
    const fade = 1 - r * r;
    opacity[sample] = CONTACT_OPACITY * fade * fade;
  }
  return opacity;
}

// ---------------------------------------------------------------- geometry

/** One frame's triangles in world space, each with one flat colour. */
interface Triangles {
  readonly count: number;
  /** Three vertices, nine numbers a triangle. */
  readonly positions: Float64Array;
  /** Outward unit face normal. */
  readonly normals: Float64Array;
  /** Linear diffuse colour (vertex colour times the material colour). */
  readonly colors: Float64Array;
  /** metalness, roughness, then linear emissive radiance (r, g, b). */
  readonly surfaces: Float64Array;
}

function collectTriangles(root: Object3D): Triangles {
  root.updateMatrixWorld(true);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const surfaces: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const normal = new Vector3();
  const attributeNormal = new Vector3();
  const normalMatrix = new Matrix3();
  const tint = new Color();
  root.traverse((object) => {
    if (!(object instanceof Mesh) || !isShown(object)) return;
    const material = object.material;
    if (!(material instanceof MeshStandardMaterial) || hasTextures(material)) {
      throw new Error(`avatar walker: ${object.name} needs an untextured MeshStandardMaterial`);
    }
    const geometry = object.geometry;
    const position = geometry.getAttribute('position');
    const vertexNormal = geometry.getAttribute('normal');
    const color = material.vertexColors ? geometry.getAttribute('color') : undefined;
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    normalMatrix.getNormalMatrix(object.matrixWorld);
    const emissive = material.emissive.clone().multiplyScalar(material.emissiveIntensity);
    for (let first = 0; first + 2 < count; first += 3) {
      const ia = index ? index.getX(first) : first;
      const ib = index ? index.getX(first + 1) : first + 1;
      const ic = index ? index.getX(first + 2) : first + 2;
      a.fromBufferAttribute(position, ia).applyMatrix4(object.matrixWorld);
      b.fromBufferAttribute(position, ib).applyMatrix4(object.matrixWorld);
      c.fromBufferAttribute(position, ic).applyMatrix4(object.matrixWorld);
      normal.subVectors(b, a).cross(c.clone().sub(a));
      if (normal.lengthSq() < 1e-18) continue;
      normal.normalize();
      if (vertexNormal) {
        attributeNormal.fromBufferAttribute(vertexNormal, ia).applyMatrix3(normalMatrix);
        if (attributeNormal.dot(normal) < 0) normal.negate();
      }
      tint.copy(material.color);
      if (color) {
        const r = color.getX(ia);
        const g = color.getY(ia);
        const bl = color.getZ(ia);
        for (const other of [ib, ic]) {
          if (color.getX(other) !== r || color.getY(other) !== g || color.getZ(other) !== bl) {
            throw new Error(`avatar walker: ${object.name} blends colours across a triangle; this renderer shades flat colours only`);
          }
        }
        tint.multiply(new Color(r, g, bl));
      }
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      normals.push(normal.x, normal.y, normal.z);
      colors.push(tint.r, tint.g, tint.b);
      surfaces.push(material.metalness, material.roughness, emissive.r, emissive.g, emissive.b);
    }
  });
  return {
    count: normals.length / 3,
    positions: Float64Array.from(positions),
    normals: Float64Array.from(normals),
    colors: Float64Array.from(colors),
    surfaces: Float64Array.from(surfaces),
  };
}

function isShown(object: Object3D): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

function hasTextures(material: MeshStandardMaterial): boolean {
  return [
    material.map,
    material.normalMap,
    material.roughnessMap,
    material.metalnessMap,
    material.emissiveMap,
    material.aoMap,
    material.alphaMap,
    material.envMap,
  ].some((texture) => texture !== null) || material.transparent;
}

// ---------------------------------------------------------------- raster

/**
 * Z-buffer the front faces (three's default FrontSide, counter-clockwise) at
 * sample centres. `hit` holds a triangle index or -1, `depth` the view depth.
 */
function rasterize(triangles: Triangles, camera: ViewCamera): { hit: Int32Array; depth: Float64Array } {
  const { eye, forward, right, up, tanHalf, samples } = camera;
  const hit = new Int32Array(samples * samples).fill(-1);
  const depth = new Float64Array(samples * samples).fill(Number.POSITIVE_INFINITY);
  const screen = new Float64Array(9);
  const p = triangles.positions;
  for (let t = 0; t < triangles.count; t += 1) {
    for (let v = 0; v < 3; v += 1) {
      const ox = p[t * 9 + v * 3]! - eye.x;
      const oy = p[t * 9 + v * 3 + 1]! - eye.y;
      const oz = p[t * 9 + v * 3 + 2]! - eye.z;
      const w = ox * forward.x + oy * forward.y + oz * forward.z;
      const ndcX = (ox * right.x + oy * right.y + oz * right.z) / (w * tanHalf);
      const ndcY = (ox * up.x + oy * up.y + oz * up.z) / (w * tanHalf);
      screen[v * 3] = ((ndcX + 1) / 2) * samples;
      screen[v * 3 + 1] = ((1 - ndcY) / 2) * samples;
      screen[v * 3 + 2] = w;
    }
    const x0 = screen[0]!, y0 = screen[1]!, w0 = screen[2]!;
    const x1 = screen[3]!, y1 = screen[4]!, w1 = screen[5]!;
    const x2 = screen[6]!, y2 = screen[7]!, w2 = screen[8]!;
    // y runs down the screen, so a counter-clockwise (front) face has negative area.
    const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (area >= 0) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(samples - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(samples - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let y = minY; y <= maxY; y += 1) {
      const sy = y + 0.5;
      for (let x = minX; x <= maxX; x += 1) {
        const sx = x + 0.5;
        const b0 = ((x2 - x1) * (sy - y1) - (y2 - y1) * (sx - x1)) / area;
        const b1 = ((x0 - x2) * (sy - y2) - (y0 - y2) * (sx - x2)) / area;
        const b2 = 1 - b0 - b1;
        if (b0 < 0 || b1 < 0 || b2 < 0) continue;
        // Perspective-correct: 1/w interpolates linearly on screen.
        const z = 1 / (b0 / w0 + b1 / w1 + b2 / w2);
        const sample = y * samples + x;
        if (z >= depth[sample]!) continue;
        depth[sample] = z;
        hit[sample] = t;
      }
    }
  }
  return { hit, depth };
}

// ---------------------------------------------------------------- the sun

interface ShadowMap {
  /** Texel index of the window's first column and row in the full map. */
  readonly column: number;
  readonly row: number;
  readonly columns: number;
  readonly rows: number;
  /** Distance from the light along its direction; +Infinity where nothing is. */
  readonly depth: Float64Array;
  /**
   * The nearest and farthest depth within PCF_REACH texels of each texel: a
   * receiver nearer than every texel its taps can touch is lit, and one
   * beyond them all is in shadow, so its taps need not be read.
   */
  readonly nearest: Float64Array;
  readonly farthest: Float64Array;
}

/** Texels a lookup's taps can touch around its own: the disk radius plus the bilinear footprint. */
const PCF_REACH = Math.ceil(SHADOW_RADIUS) + 1;

interface SunLight {
  shadowMap(triangles: Triangles): ShadowMap;
  /** 0..1 of the sun reaching a point on a triangle (three's getShadow, PCF). */
  visibility(map: ShadowMap, triangles: Triangles, triangle: number, point: Vector3): number;
}

/**
 * The engine's sun over a figure at the origin: the light stands SUN_OFFSET
 * from the focus and its shadow camera is orthographic, SHADOW_TEXEL a texel,
 * centred on the focus, so the figure meets the texel grid as a player on a
 * whole texel does. As three does for FrontSide materials, the map stores back
 * faces, and a receiver is pushed out along its normal by the normal bias.
 */
function createSunLight(): SunLight {
  const toLight = new Vector3(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z).normalize();
  // The light camera's basis as Object3D.lookAt builds it (up +Y).
  const back = toLight.clone();
  const across = new Vector3(0, 1, 0).cross(back).normalize();
  const upward = back.clone().cross(across);
  // Imported bindings are copied once: under a module runner every read of
  // one is a getter call, and these are read per sample.
  const texelSize = SHADOW_TEXEL;
  const normalBias = SHADOW_NORMAL_BIAS;
  const half = SHADOW_MAP_SIZE / 2;
  const at = new Float64Array(3);
  /** Texel column, row and light depth of a world point, into `at`. */
  const texel = (x: number, y: number, z: number): Float64Array => {
    at[0] = (x * across.x + y * across.y + z * across.z) / texelSize + half;
    at[1] = (x * upward.x + y * upward.y + z * upward.z) / texelSize + half;
    // Distance from a plane through the light, along the light's direction.
    at[2] = -(x * back.x + y * back.y + z * back.z);
    return at;
  };
  // three's 5-tap Vogel disk (vogelDiskSample), in texels, at evenly spaced
  // rotations: the average the engine's per-pixel noise rotation dithers to.
  const disk: number[] = [];
  for (let rotation = 0; rotation < PCF_ROTATIONS; rotation += 1) {
    const phi = (rotation / PCF_ROTATIONS) * Math.PI * 2;
    for (let i = 0; i < VOGEL_SAMPLES; i += 1) {
      const r = Math.sqrt((i + 0.5) / VOGEL_SAMPLES) * SHADOW_RADIUS;
      const theta = i * GOLDEN_ANGLE + phi;
      disk.push(Math.cos(theta) * r, Math.sin(theta) * r);
    }
  }

  return {
    shadowMap(triangles) {
      const p = triangles.positions;
      const n = triangles.normals;
      const projected = new Float64Array(triangles.count * 9);
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let t = 0; t < triangles.count; t += 1) {
        for (let v = 0; v < 3; v += 1) {
          texel(p[t * 9 + v * 3]!, p[t * 9 + v * 3 + 1]!, p[t * 9 + v * 3 + 2]!);
          projected.set(at, t * 9 + v * 3);
          const tx = at[0]!;
          const ty = at[1]!;
          minX = Math.min(minX, tx);
          minY = Math.min(minY, ty);
          maxX = Math.max(maxX, tx);
          maxY = Math.max(maxY, ty);
        }
      }
      // An empty margin wider than the taps' reach, so any lookup outside the
      // window reads only empty texels.
      const margin = PCF_REACH + 2;
      const column = Math.floor(minX) - margin;
      const row = Math.floor(minY) - margin;
      const columns = Math.ceil(maxX) + margin + 1 - column;
      const rows = Math.ceil(maxY) + margin + 1 - row;
      const depth = new Float64Array(columns * rows).fill(Number.POSITIVE_INFINITY);
      for (let t = 0; t < triangles.count; t += 1) {
        const facing = n[t * 3]! * toLight.x + n[t * 3 + 1]! * toLight.y + n[t * 3 + 2]! * toLight.z;
        if (facing >= 0) continue; // back faces only
        const q = t * 9;
        const x0 = projected[q]! - column, y0 = projected[q + 1]! - row, d0 = projected[q + 2]!;
        const x1 = projected[q + 3]! - column, y1 = projected[q + 4]! - row, d1 = projected[q + 5]!;
        const x2 = projected[q + 6]! - column, y2 = projected[q + 7]! - row, d2 = projected[q + 8]!;
        const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
        if (Math.abs(area) < 1e-12) continue;
        const loX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
        const hiX = Math.min(columns - 1, Math.ceil(Math.max(x0, x1, x2)));
        const loY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
        const hiY = Math.min(rows - 1, Math.ceil(Math.max(y0, y1, y2)));
        for (let y = loY; y <= hiY; y += 1) {
          const sy = y + 0.5;
          for (let x = loX; x <= hiX; x += 1) {
            const sx = x + 0.5;
            const b0 = ((x2 - x1) * (sy - y1) - (y2 - y1) * (sx - x1)) / area;
            const b1 = ((x0 - x2) * (sy - y2) - (y0 - y2) * (sx - x2)) / area;
            const b2 = 1 - b0 - b1;
            if (b0 < 0 || b1 < 0 || b2 < 0) continue;
            const d = b0 * d0 + b1 * d1 + b2 * d2;
            const index = y * columns + x;
            if (d < depth[index]!) depth[index] = d;
          }
        }
      }
      const nearest = new Float64Array(depth.length);
      const farthest = new Float64Array(depth.length);
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < columns; x += 1) {
          let low = Number.POSITIVE_INFINITY;
          // Beyond the window nothing occludes, as if at infinite depth.
          let high = x < PCF_REACH || y < PCF_REACH || x >= columns - PCF_REACH || y >= rows - PCF_REACH
            ? Number.POSITIVE_INFINITY
            : Number.NEGATIVE_INFINITY;
          for (let dy = -PCF_REACH; dy <= PCF_REACH; dy += 1) {
            for (let dx = -PCF_REACH; dx <= PCF_REACH; dx += 1) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
              const d = depth[ny * columns + nx]!;
              if (d < low) low = d;
              if (d > high) high = d;
            }
          }
          nearest[y * columns + x] = low;
          farthest[y * columns + x] = high;
        }
      }
      return { column, row, columns, rows, depth, nearest, farthest };
    },

    visibility(map, triangles, triangle, point) {
      const n = triangles.normals;
      texel(
        point.x + n[triangle * 3]! * normalBias,
        point.y + n[triangle * 3 + 1]! * normalBias,
        point.z + n[triangle * 3 + 2]! * normalBias,
      );
      const tx = at[0]!;
      const ty = at[1]!;
      const reference = at[2]!;
      const cx = Math.floor(tx) - map.column;
      const cy = Math.floor(ty) - map.row;
      if (cx < 0 || cy < 0 || cx >= map.columns || cy >= map.rows) return 1;
      if (reference <= map.nearest[cy * map.columns + cx]!) return 1;
      if (reference > map.farthest[cy * map.columns + cx]!) return 0;
      let sum = 0;
      for (let i = 0; i < disk.length; i += 2) {
        // Hardware PCF: bilinear weights over the four nearest texel centres.
        const x = tx + disk[i]! - 0.5 - map.column;
        const y = ty + disk[i + 1]! - 0.5 - map.row;
        const column = Math.floor(x);
        const row = Math.floor(y);
        const fx = x - column;
        const fy = y - row;
        const top = litTexel(map, column, row, reference) * (1 - fx) +
          litTexel(map, column + 1, row, reference) * fx;
        const bottom = litTexel(map, column, row + 1, reference) * (1 - fx) +
          litTexel(map, column + 1, row + 1, reference) * fx;
        sum += top * (1 - fy) + bottom * fy;
      }
      return sum / (disk.length / 2);
    },
  };
}

/** LessEqual depth comparison at one texel of the window; outside it nothing occludes. */
function litTexel(map: ShadowMap, x: number, y: number, reference: number): number {
  if (x < 0 || y < 0 || x >= map.columns || y >= map.rows) return 1;
  return reference <= map.depth[y * map.columns + x]! ? 1 : 0;
}

// ---------------------------------------------------------------- shading

type Shading = (
  triangles: Triangles,
  triangle: number,
  viewDir: Vector3,
  sunVisibility: number,
  out: Float64Array,
) => void;

/**
 * three r186's MeshStandardMaterial under one directional and one hemisphere
 * light, then ACES filmic and the sRGB transfer, as the engine renders
 * (world-engine.ts). Flat shading, so the face normal is the shading normal.
 * `out` receives display-encoded sRGB in 0..1.
 */
function createShading(): Shading {
  const toLight = new Vector3(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z).normalize();
  // Light colours are sRGB hex, converted to linear as three.js does.
  const sun = new Color(SUN_COLOR).multiplyScalar(SUN_INTENSITY).toArray();
  const sky = new Color(HEMISPHERE_SKY).multiplyScalar(HEMISPHERE_INTENSITY).toArray();
  const ground = new Color(HEMISPHERE_GROUND).multiplyScalar(HEMISPHERE_INTENSITY).toArray();
  const favg = DIELECTRIC_F0 + (1 - DIELECTRIC_F0) * 0.047619;
  const dfg = dfgTable();
  const half = new Vector3();
  const linear = [0, 0, 0];

  return (triangles, t, viewDir, sunVisibility, out) => {
    const nx = triangles.normals[t * 3]!;
    const ny = triangles.normals[t * 3 + 1]!;
    const nz = triangles.normals[t * 3 + 2]!;
    const metalness = triangles.surfaces[t * 5]!;
    const roughness = Math.min(1, Math.max(triangles.surfaces[t * 5 + 1]!, MIN_ROUGHNESS));
    const dotNV = saturate(nx * viewDir.x + ny * viewDir.y + nz * viewDir.z);
    const dotNL = saturate(nx * toLight.x + ny * toLight.y + nz * toLight.z);
    half.copy(toLight).add(viewDir).normalize();
    const dotNH = saturate(nx * half.x + ny * half.y + nz * half.z);
    const dotVH = saturate(viewDir.dot(half));
    const scale = sampleDfg(dfg, roughness, dotNV, 0);
    const bias = sampleDfg(dfg, roughness, dotNV, 1);
    // GGX (Smith-correlated visibility), as BRDF_GGX.
    const alpha = roughness * roughness;
    const a2 = alpha * alpha;
    const gv = dotNL * Math.sqrt(a2 + (1 - a2) * dotNV * dotNV);
    const gl = dotNV * Math.sqrt(a2 + (1 - a2) * dotNL * dotNL);
    const visibility = 0.5 / Math.max(gv + gl, EPSILON);
    const denominator = dotNH * dotNH * (a2 - 1) + 1;
    const distribution = (RECIPROCAL_PI * a2) / (denominator * denominator);
    const fresnel = Math.pow(2, (-5.55473 * dotVH - 6.98316) * dotVH);
    const hemiWeight = 0.5 * ny + 0.5;
    const ess = scale + bias;
    for (let channel = 0; channel < 3; channel += 1) {
      const albedo = triangles.colors[t * 3 + channel]!;
      const diffuse = albedo * (1 - metalness);
      const specularBlended = DIELECTRIC_F0 * (1 - metalness) + albedo * metalness;
      const irradiance = dotNL * sun[channel]! * sunVisibility;
      // Direct: GGX with multi-scattering compensation, and the diffuse the
      // interface lets through (glTF fresnel_mix).
      const specularF = specularBlended * (1 - fresnel) + fresnel;
      const compensation = 1 + specularBlended * (1 / ess - 1);
      const directSpecular = irradiance * specularF * visibility * distribution * compensation;
      const diffuseF = DIELECTRIC_F0 * (1 - fresnel) + fresnel;
      const directDiffuse = irradiance * RECIPROCAL_PI * diffuse * (1 - diffuseF);
      // Hemisphere: indirect diffuse less what the specular lobe keeps.
      const hemisphere = ground[channel]! + (sky[channel]! - ground[channel]!) * hemiWeight;
      const singleScatter = DIELECTRIC_F0 * scale + bias;
      const multiScatter = ((singleScatter * favg) / (1 - (1 - ess) * favg)) * (1 - ess);
      const indirectDiffuse = hemisphere * RECIPROCAL_PI * diffuse * (1 - singleScatter - multiScatter);
      const emissive = triangles.surfaces[t * 5 + 2 + channel]!;
      linear[channel] = directDiffuse + directSpecular + indirectDiffuse + emissive;
    }
    acesFilmic(linear);
    out[0] = srgbTransfer(linear[0]!);
    out[1] = srgbTransfer(linear[1]!);
    out[2] = srgbTransfer(linear[2]!);
  };
}

function saturate(value: number): number {
  return Math.min(1, Math.max(0, value));
}

interface DfgTable {
  readonly width: number;
  readonly height: number;
  /** Two channels a texel: the split-sum scale and bias. */
  readonly values: Float64Array;
}

/** The DFG table three binds as `dfgLUT` for MeshStandardMaterial, decoded from half floats. */
function dfgTable(): DfgTable {
  const texture = getDFGLUT();
  const { width, height, data } = texture.image as { width: number; height: number; data: Uint16Array };
  return { width, height, values: Float64Array.from(data, (value) => DataUtils.fromHalfFloat(value)) };
}

/** One channel of the table, sampled bilinearly with edge clamping as its LinearFilter does. */
function sampleDfg(table: DfgTable, u: number, v: number, channel: number): number {
  const { width, height, values } = table;
  const x = Math.min(width - 1, Math.max(0, u * width - 0.5));
  const y = Math.min(height - 1, Math.max(0, v * height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const top = values[(y0 * width + x0) * 2 + channel]! * (1 - fx) + values[(y0 * width + x1) * 2 + channel]! * fx;
  const bottom = values[(y1 * width + x0) * 2 + channel]! * (1 - fx) + values[(y1 * width + x1) * 2 + channel]! * fx;
  return top * (1 - fy) + bottom * fy;
}

const ACES_EXPOSURE = TONE_MAPPING_EXPOSURE / 0.6;

/** three's ACESFilmicToneMapping (tonemapping_pars_fragment), in place. */
function acesFilmic(color: number[]): void {
  const exposure = ACES_EXPOSURE;
  const r = color[0]! * exposure;
  const g = color[1]! * exposure;
  const b = color[2]! * exposure;
  const fr = rrtAndOdtFit(0.59719 * r + 0.35458 * g + 0.04823 * b);
  const fg = rrtAndOdtFit(0.076 * r + 0.90834 * g + 0.01566 * b);
  const fb = rrtAndOdtFit(0.0284 * r + 0.13383 * g + 0.83777 * b);
  color[0] = saturate(1.60475 * fr - 0.53108 * fg - 0.07367 * fb);
  color[1] = saturate(-0.10208 * fr + 1.10813 * fg - 0.00605 * fb);
  color[2] = saturate(-0.00327 * fr - 0.07276 * fg + 1.07602 * fb);
}

function rrtAndOdtFit(v: number): number {
  return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
}

/** three's sRGBTransferOETF (colorspace_pars_fragment). */
function srgbTransfer(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : Math.pow(value, 0.41666) * 1.055 - 0.055;
}

// ---------------------------------------------------------------- the strip

function joinCells(cells: readonly Uint8Array[]): WalkerStrip {
  const width = cells.length * WALKER_CELL_PX;
  const height = WALKER_CELL_PX;
  const rgba = new Uint8Array(width * height * 4);
  cells.forEach((cell, index) => {
    for (let y = 0; y < height; y += 1) {
      rgba.set(
        cell.subarray(y * WALKER_CELL_PX * 4, (y + 1) * WALKER_CELL_PX * 4),
        (y * width + index * WALKER_CELL_PX) * 4,
      );
    }
  });
  return { width, height, cells: cells.length, rgba };
}

function assertEdgeMargin(cell: Uint8Array, index: number): void {
  for (let y = 0; y < WALKER_CELL_PX; y += 1) {
    for (let x = 0; x < WALKER_CELL_PX; x += 1) {
      const inside = x >= EDGE_MARGIN_PX && y >= EDGE_MARGIN_PX &&
        x < WALKER_CELL_PX - EDGE_MARGIN_PX && y < WALKER_CELL_PX - EDGE_MARGIN_PX;
      if (!inside && cell[(y * WALKER_CELL_PX + x) * 4 + 3] !== 0) {
        throw new Error(`avatar walker: cell ${index} reaches its edge at (${x}, ${y}); widen FRAME_HEIGHT`);
      }
    }
  }
}

/** The largest difference between two equal-length byte buffers, in any channel. */
export function maxChannelDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let max = 0;
  for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}

/** One cell of a strip, as its own RGBA buffer. */
export function stripCell(strip: WalkerStrip, index: number): Uint8Array {
  const cell = new Uint8Array(strip.height * strip.height * 4);
  for (let y = 0; y < strip.height; y += 1) {
    const start = (y * strip.width + index * strip.height) * 4;
    cell.set(strip.rgba.subarray(start, start + strip.height * 4), y * strip.height * 4);
  }
  return cell;
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 8-bit RGBA PNG, each row filtered by whichever filter leaves the least to compress. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    let bestRow = new Uint8Array(0);
    for (let filter = 0; filter <= 4; filter += 1) {
      let cost = 0;
      for (let i = 0; i < stride; i += 1) {
        const left = i >= 4 ? row[i - 4]! : 0;
        const up = above ? above[i]! : 0;
        const upLeft = above && i >= 4 ? above[i - 4]! : 0;
        const predicted = filter === 0 ? 0
          : filter === 1 ? left
          : filter === 2 ? up
          : filter === 3 ? (left + up) >> 1
          : paeth(left, up, upLeft);
        const value = (row[i]! - predicted) & 0xff;
        candidate[i] = value;
        cost += value < 128 ? value : 256 - value;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = filter;
        bestRow = candidate.slice();
      }
    }
    raw[y * (stride + 1)] = best;
    raw.set(bestRow, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Decode an 8-bit RGBA, non-interlaced PNG such as `encodePng` writes. */
export function decodePng(file: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const bytes = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error('only 8-bit RGBA, non-interlaced PNGs');
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= 4 ? rgba[y * stride + i - 4]! : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= 4 ? rgba[(y - 1) * stride + i - 4]! : 0;
      const predicted = filter === 0 ? 0
        : filter === 1 ? left
        : filter === 2 ? up
        : filter === 3 ? (left + up) >> 1
        : paeth(left, up, upLeft);
      rgba[y * stride + i] = (source[i]! + predicted) & 0xff;
    }
  }
  return { width, height, rgba };
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}
