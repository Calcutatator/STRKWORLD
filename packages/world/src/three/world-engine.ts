import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import type { WorldConfig } from '../runtime.js';
import { createDomKeyboard, type DomKeyboard } from '../dom-keyboard.js';
import { createWorldSession, type WorldSession } from '../world-session.js';
import { createInteractChip, isTouchScreen, type InteractChip } from '../interact-chip.js';
import { createAvatarFigure, disposeAvatarFigureCache } from './avatar-figure.js';
import { CAMERA_FOV, createCameraRig, type CameraRig } from './camera-rig.js';
import { createImageTextureLoader } from './image-textures.js';
import { createCanvasLabelFactory } from './labels.js';
import {
  HEMISPHERE_GROUND,
  HEMISPHERE_INTENSITY,
  HEMISPHERE_SKY,
  SHADOW_EXTENT,
  SHADOW_FAR,
  SHADOW_MAP_SIZE,
  SHADOW_NEAR,
  SHADOW_NORMAL_BIAS,
  SHADOW_RADIUS,
  SHADOW_TEXEL,
  SUN_COLOR,
  SUN_INTENSITY,
  SUN_OFFSET,
  TONE_MAPPING_EXPOSURE,
} from './lighting.js';
import { createPresenter, type Presenter } from './presenter.js';
import { disposeSandboxCaches } from './sandbox-view.js';
import { createSky, SKY_HORIZON } from './sky.js';

/**
 * The Three.js renderer for the World (D-059).
 *
 * One engine owns one WebGL context for the lifetime of a World mount. The
 * ref-counted host (host.ts) guarantees there is only ever one engine, and
 * `rebind` swaps the gameplay session when the Shell hands over a new bus
 * without paying for a second context. Teardown is synchronous: a renderer
 * that waited for the next animation frame would never tear down in a hidden
 * tab, which is the leak host.ts exists to prevent.
 */

export interface WorldEngine {
  /**
   * Replace the gameplay session with one bound to a new Shell config. Its
   * `vaultOpen` is ignored: the Vault stays as the engine was created (D-077).
   */
  rebind(config: WorldConfig): void;
  /** Re-measure the mount; call after moving it to a new parent. */
  resize(): void;
  destroy(): void;
}

export interface WorldEngineOptions {
  readonly mount: HTMLElement;
  readonly config: WorldConfig;
  /**
   * Test seam: node has no WebGL, so engine lifecycle tests inject a stand-in
   * with the renderer surface the engine uses. Production omits it.
   */
  readonly createRenderer?: () => WebGLRenderer;
}

/** A stalled tab must not deliver one enormous frame. */
export const MAX_FRAME_MS = 50;

const FOG_NEAR = 26;
const FOG_FAR = 64;
const ERROR_REPORT_INTERVAL_MS = 1000;

/**
 * D-132: how far the fog is pushed back while a cinematic shot is running —
 * the roof swing's ride, which looks south over the river to the skyline.
 * Short of the camera's 240 far plane, so the horizon still fades out.
 */
export const VISTA_FOG_NEAR = 60;
export const VISTA_FOG_FAR = 215;

/**
 * The fog's linear range, in view depth, for a player `elevation` up: pushed
 * back as they climb, so a tower top still shows what they built below.
 * `vista` (D-132) pushes it back further still for the swing's ride, so the
 * south vista is inside it.
 */
export function fogRange(elevation: number, vista = false): { readonly near: number; readonly far: number } {
  if (vista) return { near: Math.max(VISTA_FOG_NEAR, FOG_NEAR + elevation), far: VISTA_FOG_FAR };
  return { near: FOG_NEAR + elevation, far: FOG_FAR + elevation * 1.6 };
}

/**
 * The player's `prefers-reduced-motion`, read live from the window the World
 * is mounted in, as the engine reads its pixel ratio and visibility; false
 * wherever it cannot be read.
 */
export function prefersReducedMotion(win: Window): boolean {
  try {
    return win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

export function createWorldEngine(options: WorldEngineOptions): WorldEngine {
  const { mount } = options;
  const doc = mount.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error('World mount is not attached to a window');

  const cleanup: Array<() => void> = [];
  const runCleanup = (): unknown[] => {
    const errors: unknown[] = [];
    while (cleanup.length > 0) {
      const step = cleanup.pop()!;
      try {
        step();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  let renderer: WebGLRenderer;
  let presenter: Presenter;
  let rig: CameraRig;
  let session: WorldSession | null = null;
  let keyboard: DomKeyboard | null = null;
  // D-123: the key chip naming what E would use; on a touch screen, the tap button.
  let chip: InteractChip | null = null;
  let destroyed = false;
  let lastTime: number | null = null;
  // One report slot per frame stage, so a handoff failing every frame cannot
  // hide a presenter or renderer failure behind the rate limit.
  const lastReported = new Map<string, number>();

  // The Vault opens on shadow accounts, behind the Shell's switch (D-077).
  // Read once: the street and its rooms are built once, below, and cannot
  // change, so a rebind keeps the value the engine was created with.
  const vaultOpen = options.config.vaultOpen === true;
  // Leaderboard phase 1: the placement stand, read once the same way.
  const placementStand = options.config.placementStand === true;

  const scene = new Scene();
  const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 240);
  const sun = new DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  const sky = createSky();

  const reportFrameError = (stage: string, error: unknown): void => {
    // Surface the failure like an uncaught error, rate-limited so a handoff
    // that fails every frame cannot flood the console. three requests the next
    // animation frame before running this callback (WebGLAnimation.js), so the
    // loop survives either way; the session's rollback rules retry next frame.
    const now = win.performance?.now?.() ?? Date.now();
    if (now - (lastReported.get(stage) ?? -Infinity) < ERROR_REPORT_INTERVAL_MS) return;
    lastReported.set(stage, now);
    win.setTimeout(() => {
      throw error;
    }, 0);
  };

  const stopSession = (): void => {
    const current = session;
    const currentKeyboard = keyboard;
    session = null;
    keyboard = null;
    chip?.show(null);
    const errors: unknown[] = [];
    try {
      current?.destroy();
    } catch (error) {
      errors.push(error);
    }
    try {
      currentKeyboard?.destroy();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'World session teardown failed');
  };

  const startSession = (config: WorldConfig): void => {
    // D-114: a primary press on the canvas strikes in the arena.
    const nextKeyboard = createDomKeyboard({ window: win, document: doc, canvas: renderer.domElement });
    let view: ReturnType<Presenter['bindSession']> | undefined;
    try {
      view = presenter.bindSession(config.remotePeers);
      const bound = view;
      const keyChip = chip;
      // D-123: the target glows in the scene and its words go to the chip.
      const sessionView = keyChip
        ? {
          ...bound,
          setInteractionPrompt: (prompt: Parameters<typeof bound.setInteractionPrompt>[0]) => {
            bound.setInteractionPrompt(prompt);
            keyChip.show(prompt);
          },
        }
        : bound;
      session = createWorldSession({
        config: { out: config.out, in: config.in },
        view: sessionView,
        keyboard: nextKeyboard,
        sandbox: config.sandbox,
        football: config.football,
        // The gladiator pit's ring (D-114), and reduced motion for its leaps.
        ...(config.arena ? { arena: config.arena } : {}),
        // The Exchange roof's lookout swing (D-132).
        ...(config.roofSwing ? { roofSwing: config.roofSwing } : {}),
        reducedMotion: () => prefersReducedMotion(win),
        // The creation value, never `config.vaultOpen`: the presenter drew
        // the street and rooms from it, and a session must walk the same map.
        vaultOpen,
        placementStand,
      });
      keyboard = nextKeyboard;
    } catch (error) {
      session = null;
      try {
        nextKeyboard.destroy();
      } catch {
        // Preserve the session construction failure.
      }
      try {
        view?.destroy();
      } catch {
        // Preserve the session construction failure.
      }
      throw error;
    }
  };

  const resize = (): void => {
    if (destroyed) return;
    const width = mount.clientWidth;
    const height = mount.clientHeight;
    // A mount mid-move measures 0×0; keep the last good size until it lands.
    if (!(width > 0) || !(height > 0)) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  // Each stage is isolated: a failing animation must not freeze the camera,
  // and nothing short of a broken renderer may skip drawing the frame.
  const guard = (name: string, stage: () => void): void => {
    try {
      stage();
    } catch (error) {
      reportFrameError(name, error);
    }
  };

  const frame = (time: number): void => {
    const delta = lastTime === null ? 0 : Math.min(Math.max(time - lastTime, 0), MAX_FRAME_MS);
    lastTime = time;
    guard('session', () => session?.update(delta, { cameraYaw: rig.yaw }));
    guard('presenter', () => presenter.update(delta));
    guard('camera', () => {
      if (presenter.consumeSnap()) rig.snap();
      const focus = presenter.player.ground;
      // A bad presentation value must never reach the light, fog or camera.
      const elevation = Number.isFinite(presenter.player.elevation) ? presenter.player.elevation : 0;
      const shot = presenter.cameraShot;
      rig.update(delta, focus, presenter.cameraBounds, elevation, presenter.cameraPreset, shot);
      presenter.updateOcclusion(camera.position, delta);
      // Snap the light to whole shadow texels so edges do not shimmer as the
      // player walks, and lift it with the player on tall sandbox towers.
      const sx = Math.round(focus.x / SHADOW_TEXEL) * SHADOW_TEXEL;
      const sz = Math.round(focus.z / SHADOW_TEXEL) * SHADOW_TEXEL;
      const sy = Math.round(elevation);
      sun.position.set(sx + SUN_OFFSET.x, sy + SUN_OFFSET.y, sz + SUN_OFFSET.z);
      sun.target.position.set(sx, sy, sz);
      sun.target.updateMatrixWorld();
      // Push the fog back as the player climbs, so a tower top still shows
      // what they built below.
      const fog = scene.fog as Fog;
      const range = fogRange(elevation, shot !== null);
      fog.near = range.near;
      fog.far = range.far;
      sky.position.copy(camera.position);
    });
    guard('render', () => renderer.render(scene, camera));
  };

  // The first frame after a hidden tab returns measures from the return, not
  // from when rendering stopped.
  const onVisibilityChange = (): void => {
    if (doc.visibilityState === 'visible') lastTime = null;
  };

  try {
    renderer = options.createRenderer
      ? options.createRenderer()
      : new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    cleanup.push(() => {
      renderer.dispose();
      renderer.forceContextLoss();
    });
    renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
    renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap was removed in r186; PCF with a radius softens edges.
    renderer.shadowMap.type = PCFShadowMap;
    renderer.setClearColor(SKY_HORIZON);
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
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
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    sun.shadow.radius = SHADOW_RADIUS;
    sun.shadow.camera.left = -SHADOW_EXTENT;
    sun.shadow.camera.right = SHADOW_EXTENT;
    sun.shadow.camera.top = SHADOW_EXTENT;
    sun.shadow.camera.bottom = -SHADOW_EXTENT;
    sun.shadow.camera.near = SHADOW_NEAR;
    sun.shadow.camera.far = SHADOW_FAR;
    sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
    scene.add(sun, sun.target);
    cleanup.push(() => sun.dispose());

    presenter = createPresenter({
      parent: scene,
      labels: createCanvasLabelFactory(doc),
      figures: createAvatarFigure,
      images: createImageTextureLoader(doc),
      reducedMotion: () => prefersReducedMotion(win),
      vaultOpen,
      placementStand,
    });
    cleanup.push(() => presenter.dispose());
    cleanup.push(() => disposeAvatarFigureCache());

    {
      const created = createInteractChip({
        mount,
        touch: isTouchScreen(win),
        onPress: () => guard('interact', () => session?.interact()),
        reducedMotion: () => prefersReducedMotion(win),
      });
      chip = created;
      cleanup.push(() => {
        chip = null;
        created.destroy();
      });
    }
    cleanup.push(() => disposeSandboxCaches());

    // A fixed camera: it reads no pointer or wheel input.
    rig = createCameraRig({ camera });
    cleanup.push(() => rig.destroy());

    startSession(options.config);
    cleanup.push(() => stopSession());

    resize();
    const observer = typeof win.ResizeObserver === 'function'
      ? new win.ResizeObserver(() => resize())
      : null;
    observer?.observe(mount);
    cleanup.push(() => observer?.disconnect());

    doc.addEventListener('visibilitychange', onVisibilityChange);
    cleanup.push(() => doc.removeEventListener('visibilitychange', onVisibilityChange));

    renderer.setAnimationLoop(frame);
    cleanup.push(() => renderer.setAnimationLoop(null));
  } catch (error) {
    destroyed = true;
    runCleanup();
    throw error;
  }

  return {
    rebind(config) {
      if (destroyed) return;
      // A failed teardown of the old session is reported, not rethrown: the
      // host treats a throwing retarget as a failed remount and would tear
      // down the engine and the fresh session with it.
      try {
        stopSession();
      } catch (error) {
        reportFrameError('rebind', error);
      }
      startSession(config);
    },
    resize,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const errors = runCleanup();
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'World engine teardown failed');
    },
  };
}
