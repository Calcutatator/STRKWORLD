import {
  ACESFilmicToneMapping,
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import type { WorldConfig } from '../runtime.js';
import { createDomKeyboard, type DomKeyboard } from '../dom-keyboard.js';
import { createWorldSession, type WorldSession } from '../world-session.js';
import { createAvatarFigure, disposeAvatarFigureCache } from './avatar-figure.js';
import { createCameraRig, type CameraRig } from './camera-rig.js';
import { createCanvasLabelFactory } from './labels.js';
import { createPresenter, type Presenter } from './presenter.js';

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
  /** Replace the gameplay session with one bound to a new Shell config. */
  rebind(config: WorldConfig): void;
  /** Re-measure the mount; call after moving it to a new parent. */
  resize(): void;
  destroy(): void;
}

export interface WorldEngineOptions {
  readonly mount: HTMLElement;
  readonly config: WorldConfig;
}

/** A stalled tab must not deliver one enormous frame. */
export const MAX_FRAME_MS = 50;

const SKY_TOP = 0x6f9edb;
const SKY_HORIZON = 0xf2dcc0;
const SKY_GROUND = 0xd8c6ad;
const FOG_NEAR = 26;
const FOG_FAR = 64;
/** Sun offset from the camera focus: high in the south-west, so facades are lit. */
const SUN_OFFSET = { x: -14, y: 24, z: 12 } as const;
const ERROR_REPORT_INTERVAL_MS = 1000;

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
  let destroyed = false;
  let lastTime: number | null = null;
  let lastReported = -Infinity;

  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 240);
  const sun = new DirectionalLight(0xffe1b3, 2.4);
  const sky = createSky();

  const reportFrameError = (error: unknown): void => {
    // Surface the failure like an uncaught error, rate-limited so a handoff
    // that fails every frame cannot flood the console. three requests the next
    // animation frame before running this callback (WebGLAnimation.js), so the
    // loop survives either way; the session's rollback rules retry next frame.
    const now = win.performance?.now?.() ?? Date.now();
    if (now - lastReported < ERROR_REPORT_INTERVAL_MS) return;
    lastReported = now;
    win.setTimeout(() => {
      throw error;
    }, 0);
  };

  const stopSession = (): void => {
    const current = session;
    const currentKeyboard = keyboard;
    session = null;
    keyboard = null;
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
    const nextKeyboard = createDomKeyboard({ window: win, document: doc });
    let view: ReturnType<Presenter['bindSession']> | undefined;
    try {
      view = presenter.bindSession(config.remotePeers);
      session = createWorldSession({
        config: { out: config.out, in: config.in },
        view,
        keyboard: nextKeyboard,
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
  const guard = (stage: () => void): void => {
    try {
      stage();
    } catch (error) {
      reportFrameError(error);
    }
  };

  const frame = (time: number): void => {
    const delta = lastTime === null ? 0 : Math.min(Math.max(time - lastTime, 0), MAX_FRAME_MS);
    lastTime = time;
    guard(() => session?.update(delta, { cameraYaw: rig.yaw }));
    guard(() => {
      rig.setInputEnabled(session ? !session.inputSuspended : false);
      presenter.update(delta);
    });
    guard(() => {
      if (presenter.consumeSnap()) rig.snap();
      const focus = presenter.player.ground;
      rig.update(delta, focus, presenter.cameraBounds);
      presenter.updateOcclusion(camera.position, delta);
      sun.position.set(focus.x + SUN_OFFSET.x, SUN_OFFSET.y, focus.z + SUN_OFFSET.z);
      sun.target.position.set(focus.x, 0, focus.z);
      sun.target.updateMatrixWorld();
      sky.position.copy(camera.position);
    });
    guard(() => renderer.render(scene, camera));
  };

  // The first frame after a hidden tab returns measures from the return, not
  // from when rendering stopped.
  const onVisibilityChange = (): void => {
    if (doc.visibilityState === 'visible') lastTime = null;
  };

  try {
    renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    cleanup.push(() => {
      renderer.dispose();
      renderer.forceContextLoss();
    });
    renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
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
    scene.add(new HemisphereLight(0xcfe3ff, 0x5b4a3c, 1.0));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -22;
    sun.shadow.camera.right = 22;
    sun.shadow.camera.top = 22;
    sun.shadow.camera.bottom = -22;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 80;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    cleanup.push(() => sun.dispose());

    presenter = createPresenter({
      parent: scene,
      labels: createCanvasLabelFactory(doc),
      figures: createAvatarFigure,
    });
    cleanup.push(() => presenter.dispose());
    cleanup.push(() => disposeAvatarFigureCache());

    rig = createCameraRig({ camera, element: canvas });
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
      stopSession();
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

/** A gradient dome that follows the camera; cheaper than a sky shader pass. */
function createSky(): Mesh<SphereGeometry, ShaderMaterial> {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new Color(SKY_TOP) },
      horizon: { value: new Color(SKY_HORIZON) },
      below: { value: new Color(SKY_GROUND) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 below;
      varying vec3 vDirection;
      void main() {
        float h = vDirection.y;
        vec3 colour = h >= 0.0
          ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55))
          : mix(horizon, below, pow(clamp(-h, 0.0, 1.0), 0.45));
        gl_FragColor = vec4(colour, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const sky = new Mesh(new SphereGeometry(200, 32, 16), material);
  sky.name = 'sky';
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}
