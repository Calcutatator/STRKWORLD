import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { createStreetMap } from '../map/street.js';
import { createCanvasLabelFactory } from './labels.js';
import {
  HEMISPHERE_GROUND,
  HEMISPHERE_INTENSITY,
  HEMISPHERE_SKY,
  SHADOW_NORMAL_BIAS,
  SHADOW_RADIUS,
  SUN_COLOR,
  SUN_INTENSITY,
  SUN_OFFSET,
  TONE_MAPPING_EXPOSURE,
} from './lighting.js';
import { createSky, SKY_HORIZON } from './sky.js';
import { buildStreet } from './street-builder.js';
import type { StreetView } from './types.js';

/**
 * The title screen's backdrop: the real overworld, floating behind the
 * connect menu and the entry gate.
 *
 * It is the street the game walks — `buildStreet` on the same map, so the
 * plaza, every building, the pitch, the props and the country around them —
 * under the game's own sky, sun and hemisphere light, seen from high above by
 * a camera that drifts slowly along the street. It runs no gameplay session,
 * reads no input and knows nothing of wallets: it is scenery.
 *
 * It is cheap on purpose, because it runs while the player is reading a menu:
 * the pixel ratio is capped, frames are limited, the shadow map is drawn once
 * (nothing that casts one moves), the loop stops while the tab is hidden, and
 * a player who prefers reduced motion gets one still frame. `destroy` frees
 * every GPU resource and loses the context, so nothing lingers when the city
 * starts its own renderer.
 */

export interface TitleBackdrop {
  /** Re-measure the mount; call after moving it to a new parent. */
  resize(): void;
  destroy(): void;
}

export interface TitleBackdropOptions {
  readonly mount: HTMLElement;
  /** Draws the Vault's door the way the game will (D-077). Default: locked. */
  readonly vaultOpen?: boolean;
  /** Called once, after the first frame has been drawn. */
  readonly onReady?: () => void;
  /** Test seam: node has no WebGL. Production omits it. */
  readonly createRenderer?: () => WebGLRenderer;
}

/** The highest device pixel ratio the backdrop draws at. */
export const TITLE_MAX_PIXEL_RATIO = 1.5;
/** The backdrop's frame cap. A slow drift needs no more. */
export const TITLE_FPS = 30;
/** One full drift along the street and back, in milliseconds. */
export const TITLE_DRIFT_PERIOD_MS = 140_000;

const FOV = 34;
const FOG_NEAR = 55;
const FOG_FAR = 150;
/** The shadow camera covers the whole district from one fixed sun. */
const SHADOW_EXTENT = 70;
const SHADOW_MAP_SIZE = 2048;
const SHADOW_FAR = 160;

export interface TitleCameraPose {
  readonly position: Vector3;
  readonly target: Vector3;
}

export interface TitleFraming {
  /** The district's centre on the ground, in world units. */
  readonly centre: { readonly x: number; readonly z: number };
  /** How far the drift runs either side of the centre, east to west. */
  readonly sweep: number;
  /** Pulls the camera back for a tall frame, which sees less of the street across. Default 1. */
  readonly pullBack?: number;
}

/**
 * Where the camera is `timeMs` into the drift. A slow sine along the street
 * with a gentle sway of the heading, high and pitched down, so the whole town
 * reads as a model under the menu. `still` holds it at the opening pose.
 */
export function titleCameraPose(framing: TitleFraming, timeMs: number, still: boolean): TitleCameraPose {
  const phase = still ? 0 : (timeMs / TITLE_DRIFT_PERIOD_MS) * Math.PI * 2;
  const along = Math.sin(phase) * framing.sweep;
  const yaw = (-24 + Math.sin(phase * 0.5 + 0.6) * 14) * (Math.PI / 180);
  const pitch = (23 + Math.sin(phase * 0.75) * 2) * (Math.PI / 180);
  const distance = 78 * (framing.pullBack ?? 1);
  // Aim at the buildings' row, north of the road, from the south: the town
  // stands up under the wordmark with the hazy country running on behind it.
  const target = new Vector3(framing.centre.x + along, 0, framing.centre.z - 8);
  const position = new Vector3(
    target.x + Math.sin(yaw) * Math.cos(pitch) * distance,
    target.y + Math.sin(pitch) * distance,
    target.z + Math.cos(yaw) * Math.cos(pitch) * distance,
  );
  return { position, target };
}

export function prefersReducedMotion(win: Window): boolean {
  try {
    return win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

export function createTitleBackdrop(options: TitleBackdropOptions): TitleBackdrop {
  const { mount } = options;
  const doc = mount.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error('Title backdrop mount is not attached to a window');

  const cleanup: Array<() => void> = [];
  const runCleanup = (): unknown[] => {
    const errors: unknown[] = [];
    while (cleanup.length > 0) {
      try {
        cleanup.pop()!();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  let destroyed = false;
  let renderer: WebGLRenderer;
  let street: StreetView;
  let readySent = false;
  let lastDrawn: number | null = null;
  let lastUpdate: number | null = null;
  let looping = false;
  const frameInterval = 1000 / TITLE_FPS;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.5, 400);
  const sky = createSky();
  const sun = new DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  const still = (): boolean => prefersReducedMotion(win);

  const map = createStreetMap({ vaultOpen: options.vaultOpen === true });
  let framing: TitleFraming = {
    centre: { x: map.width / 2, z: map.height / 2 },
    sweep: Math.max(0, map.width / 2 - 18),
  };

  const draw = (time: number): void => {
    const pose = titleCameraPose(framing, time, still());
    camera.position.copy(pose.position);
    camera.lookAt(pose.target);
    sky.position.copy(camera.position);
    renderer.render(scene, camera);
    if (!readySent) {
      readySent = true;
      try {
        options.onReady?.();
      } catch {
        // A listener's failure is the listener's; the scenery keeps drawing.
      }
    }
  };

  const frame = (time: number): void => {
    if (destroyed) return;
    if (lastDrawn !== null && time - lastDrawn < frameInterval - 1) return;
    lastDrawn = time;
    const delta = lastUpdate === null ? 0 : Math.min(Math.max(time - lastUpdate, 0), 100);
    lastUpdate = time;
    try {
      street.update(delta);
    } catch {
      // The plaza's live parts are decoration here; a failing one must not freeze the view.
    }
    draw(time);
  };

  const startLoop = (): void => {
    if (destroyed || looping) return;
    if (still()) {
      draw(0);
      return;
    }
    looping = true;
    lastDrawn = null;
    lastUpdate = null;
    renderer.setAnimationLoop(frame);
  };

  const stopLoop = (): void => {
    if (!looping) return;
    looping = false;
    renderer.setAnimationLoop(null);
  };

  const resize = (): void => {
    if (destroyed) return;
    const width = mount.clientWidth;
    const height = mount.clientHeight;
    if (!(width > 0) || !(height > 0)) return;
    renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, TITLE_MAX_PIXEL_RATIO));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // A tall phone frame sees less of the street across: pull back and widen
    // the lens a little, so the town still reads as a town under the menu.
    camera.fov = camera.aspect < 0.8 ? FOV + 8 : FOV;
    const pullBack = camera.aspect < 0.8 ? 1.2 : 1;
    framing = { ...framing, pullBack };
    const fog = scene.fog as Fog | null;
    if (fog) {
      fog.near = FOG_NEAR * pullBack;
      fog.far = FOG_FAR * pullBack;
    }
    camera.updateProjectionMatrix();
    // A still frame is only redrawn when something changes.
    if (!looping) draw(0);
  };

  const onVisibilityChange = (): void => {
    if (doc.visibilityState === 'hidden') stopLoop();
    else startLoop();
  };

  const onMotionChange = (): void => {
    stopLoop();
    if (doc.visibilityState !== 'hidden') startLoop();
  };

  try {
    renderer = options.createRenderer
      ? options.createRenderer()
      : new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    cleanup.push(() => {
      renderer.setAnimationLoop(null);
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    });
    renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, TITLE_MAX_PIXEL_RATIO));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    // Nothing that casts a shadow moves, so the map is drawn on the first
    // frame and never again.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.setClearColor(SKY_HORIZON);
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.setAttribute('aria-hidden', 'true');
    mount.appendChild(canvas);
    cleanup.push(() => canvas.parentNode?.removeChild(canvas));

    scene.fog = new Fog(SKY_HORIZON, FOG_NEAR, FOG_FAR);
    scene.background = new Color(SKY_HORIZON);
    scene.add(sky);
    cleanup.push(() => {
      sky.geometry.dispose();
      sky.material.dispose();
    });

    scene.add(new HemisphereLight(HEMISPHERE_SKY, HEMISPHERE_GROUND, HEMISPHERE_INTENSITY));
    const { centre } = framing;
    sun.position.set(centre.x + SUN_OFFSET.x * 2, SUN_OFFSET.y * 2, centre.z + SUN_OFFSET.z * 2);
    sun.target.position.set(centre.x, 0, centre.z);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    sun.shadow.radius = SHADOW_RADIUS;
    sun.shadow.camera.left = -SHADOW_EXTENT;
    sun.shadow.camera.right = SHADOW_EXTENT;
    sun.shadow.camera.top = SHADOW_EXTENT;
    sun.shadow.camera.bottom = -SHADOW_EXTENT;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = SHADOW_FAR;
    sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
    scene.add(sun, sun.target);
    sun.target.updateMatrixWorld();
    cleanup.push(() => sun.dispose());

    street = buildStreet(map, createCanvasLabelFactory(doc));
    scene.add(street.ground, street.doors, street.labels);
    cleanup.push(() => street.dispose());

    const clouds = buildClouds(framing);
    scene.add(clouds.group);
    cleanup.push(() => clouds.dispose());

    resize();
    const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => resize()) : null;
    observer?.observe(mount);
    cleanup.push(() => observer?.disconnect());

    doc.addEventListener('visibilitychange', onVisibilityChange);
    cleanup.push(() => doc.removeEventListener('visibilitychange', onVisibilityChange));
    let motionQuery: MediaQueryList | null = null;
    try {
      motionQuery = win.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    } catch {
      motionQuery = null;
    }
    motionQuery?.addEventListener?.('change', onMotionChange);
    cleanup.push(() => motionQuery?.removeEventListener?.('change', onMotionChange));

    if (doc.visibilityState !== 'hidden') startLoop();
    cleanup.push(() => stopLoop());
  } catch (error) {
    destroyed = true;
    runCleanup();
    throw error;
  }

  return {
    resize,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      looping = false;
      const errors = runCleanup();
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Title backdrop teardown failed');
    },
  };
}

/**
 * A few puffy voxel clouds drifting nowhere, high over the north edge, as in
 * the brand renders: white boxes on one shared geometry and material.
 */
function buildClouds(framing: TitleFraming): { group: Group; dispose(): void } {
  const group = new Group();
  group.name = 'title-clouds';
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial({ color: 0xfffaf0, roughness: 1, flatShading: true, fog: false });
  const spots: ReadonlyArray<readonly [number, number, number, number, number]> = [
    [-40, 20, -34, 2.6, 3],
    [-14, 25, -48, 3.2, 7],
    [12, 21, -38, 2.3, 11],
    [38, 26, -52, 3.4, 19],
    [62, 22, -40, 2.7, 23],
    [88, 24, -50, 3.0, 29],
  ];
  for (const [x, y, z, size, seed] of spots) {
    group.add(cloud(geometry, material, framing.centre.x - 30 + x, y, z, size, seed));
  }
  return {
    group,
    dispose() {
      group.parent?.remove(group);
      geometry.dispose();
      material.dispose();
    },
  };
}

function cloud(
  geometry: BoxGeometry,
  material: MeshStandardMaterial,
  x: number,
  y: number,
  z: number,
  size: number,
  seed: number,
): Object3D {
  const group = new Group();
  let state = seed;
  const random = (): number => (state = (state * 9301 + 49297) % 233280) / 233280;
  for (let index = 0; index < 9; index++) {
    const width = (1.4 + random() * 1.6) * size;
    const height = (0.9 + random() * 0.9) * size;
    const box = new Mesh(geometry, material);
    box.scale.set(width, height, width * 0.8);
    box.position.set(
      (random() - 0.5) * 4.5 * size,
      height / 2 + (index < 4 ? 0 : random() * 0.8 * size),
      (random() - 0.5) * 1.5 * size,
    );
    group.add(box);
  }
  group.position.set(x, y, z);
  return group;
}
