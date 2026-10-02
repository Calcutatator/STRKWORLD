/**
 * Character and street renders for the brand kit (docs/brand): the cast in a
 * row, a portrait, or the street, using the World's own figures, street
 * builder and lighting. Modes and parameters are in README.md.
 */
import {
  ACESFilmicToneMapping,
  BackSide,
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { AvatarSpriteKey } from '@strkworld/shared';
import { createAvatarFigure, avatarFigureHeight } from '../../src/three/avatar-figure.js';
import { buildStreet } from '../../src/three/street-builder.js';
import { createCanvasLabelFactory } from '../../src/three/labels.js';
import { createStreetMap } from '../../src/map/street.js';
import {
  HEMISPHERE_GROUND,
  HEMISPHERE_INTENSITY,
  HEMISPHERE_SKY,
  SHADOW_NORMAL_BIAS,
  SUN_COLOR,
  SUN_INTENSITY,
  SUN_OFFSET,
} from '../../src/three/lighting.js';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const log = (s: string) => {
  (document.getElementById('log') as HTMLElement).textContent += s + '\n';
  console.log(s);
};

function renderer(w: number, h: number, alpha: boolean): WebGLRenderer {
  const r = new WebGLRenderer({ antialias: true, alpha, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(w, h);
  r.outputColorSpace = SRGBColorSpace;
  r.toneMapping = ACESFilmicToneMapping;
  r.toneMappingExposure = num('exposure', 1.0);
  r.shadowMap.enabled = true;
  r.shadowMap.type = PCFShadowMap;
  if (alpha) r.setClearColor(0x000000, 0);
  document.body.appendChild(r.domElement);
  return r;
}

function lights(scene: Scene, focus: Vector3, extent: number): void {
  scene.add(new HemisphereLight(HEMISPHERE_SKY, HEMISPHERE_GROUND, HEMISPHERE_INTENSITY));
  const sun = new DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.position.set(focus.x + SUN_OFFSET.x, focus.y + SUN_OFFSET.y, focus.z + SUN_OFFSET.z);
  sun.target.position.copy(focus);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.radius = 2;
  const c = sun.shadow.camera;
  c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent; c.near = 1; c.far = 120;
  sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
  scene.add(sun, sun.target);
}

function sky(top: number, horizon: number, below: number): Mesh {
  const m = new ShaderMaterial({
    side: BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new Color(top) }, horizon: { value: new Color(horizon) }, below: { value: new Color(below) } },
    vertexShader: `varying vec3 vD; void main(){ vD=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 below; varying vec3 vD;
      void main(){ float h=vD.y; vec3 c = h>=0.0 ? mix(horizon,top,pow(clamp(h,0.0,1.0),0.55)) : mix(horizon,below,pow(clamp(-h,0.0,1.0),0.45));
      gl_FragColor=vec4(c,1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
  const s = new Mesh(new SphereGeometry(400, 32, 16), m);
  s.renderOrder = -1; s.frustumCulled = false;
  return s;
}

function idle(fig: ReturnType<typeof createAvatarFigure>, ms: number): void {
  for (let t = 0; t < ms; t += 16) fig.update(16, { moving: false, sprinting: false });
}

async function save(r: WebGLRenderer, name: string): Promise<void> {
  const url = r.domElement.toDataURL('image/png');
  await fetch(`/save?name=${name}`, { method: 'POST', body: url });
  log(`saved ${name}`);
}

function shadowCatcher(scene: Scene, opacity: number): void {
  const p = new Mesh(new PlaneGeometry(60, 60), new ShadowMaterial({ opacity }));
  p.rotation.x = -Math.PI / 2;
  p.receiveShadow = true;
  scene.add(p);
}

function castAll(o: Object3D): void {
  o.traverse((c) => { if ((c as Mesh).isMesh) { c.castShadow = true; c.receiveShadow = true; } });
}

/** One transparent full-body render per key, identical camera so the scale matches across keys. */
async function cast(): Promise<void> {
  const W = num('w', 1000), H = num('h', 1400);
  const keys = (q.get('keys') ?? '9,10,11,12,13,14,15,16').split(',');
  const yaws = (q.get('yaws') ?? '0').split(',').map(Number);
  const pitch = num('pitch', 8) * Math.PI / 180;
  const fov = num('fov', 18);
  for (const k of keys) {
    for (const yaw of yaws) {
      const r = renderer(W, H, true);
      const scene = new Scene();
      const key = `avatar-${k}` as AvatarSpriteKey;
      const fig = createAvatarFigure(key);
      fig.object.rotation.y = yaw;
      castAll(fig.object);
      idle(fig, num('idle', 400));
      scene.add(fig.object);
      shadowCatcher(scene, 0.28);
      lights(scene, new Vector3(0, 0, 0), 4);
      // fixed framing: 2.6 units tall window centred at 1.05 — big builds fill more of it
      const cam = new PerspectiveCamera(fov, W / H, 0.1, 200);
      const aimY = num('aim', 1.05);
      const dist = (num('span', 2.7) / 2) / Math.tan((fov * Math.PI) / 360);
      cam.position.set(0, aimY + Math.sin(pitch) * dist, Math.cos(pitch) * dist);
      cam.lookAt(0, aimY, 0);
      r.render(scene, cam);
      log(`${key} h=${avatarFigureHeight(key).toFixed(2)}`);
      await save(r, `cast-${k}-y${yaw}.png`);
      r.dispose(); r.domElement.remove();
    }
  }
}

/** Head-and-shoulders close-up of one key. */
async function portrait(): Promise<void> {
  const S = num('w', 1600);
  const r = renderer(S, S, true);
  const scene = new Scene();
  const key = `avatar-${q.get('key') ?? '1'}` as AvatarSpriteKey;
  const fig = createAvatarFigure(key);
  fig.object.rotation.y = num('yaw', 0.3);
  castAll(fig.object);
  idle(fig, num('idle', 400));
  scene.add(fig.object);
  lights(scene, new Vector3(0, 0, 0), 4);
  if (num('fill', 0) > 0) {
    const fill = new DirectionalLight(0xfff1dc, num('fill', 0));
    fill.position.set(num('fx', 2), 3, 10);
    scene.add(fill);
  }
  const h = avatarFigureHeight(key);
  const aimY = num('aim', h - 0.3);
  const fov = num('fov', 14);
  const span = num('span', 0.75);
  const pitch = num('pitch', 4) * Math.PI / 180;
  const dist = span / 2 / Math.tan((fov * Math.PI) / 360);
  const cam = new PerspectiveCamera(fov, 1, 0.05, 100);
  cam.position.set(num('ox', 0), aimY + Math.sin(pitch) * dist, Math.cos(pitch) * dist);
  cam.lookAt(num('ox', 0), aimY, 0);
  r.render(scene, cam);
  log(`${key} h=${h}`);
  await save(r, q.get('name') ?? `portrait-${q.get('key') ?? '1'}.png`);
}

/** Puffy voxel clouds: clusters of white boxes. */
function cloud(x: number, y: number, z: number, s: number, seed: number): Group {
  const g = new Group();
  const mat = new MeshStandardMaterial({ color: 0xfffaf0, roughness: 1, flatShading: true, fog: false });
  let r = seed;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 9; i++) {
    const w = (1.4 + rnd() * 1.6) * s, hh = (0.9 + rnd() * 0.9) * s;
    const b = new Mesh(new BoxGeometry(w, hh, w * 0.8), mat);
    b.position.set((rnd() - 0.5) * 4.5 * s, hh / 2 + (i < 4 ? 0 : rnd() * 0.8 * s), (rnd() - 0.5) * 1.5 * s);
    g.add(b);
  }
  g.position.set(x, y, z);
  return g;
}

async function world(): Promise<void> {
  const W = num('w', 1500), H = num('h', 500);
  const r = renderer(W, H, false);
  const scene = new Scene();
  const map = createStreetMap({ vaultOpen: true });
  const view = buildStreet(map, createCanvasLabelFactory(document));
  scene.add(view.ground, view.labels, view.doors);
  castAll(view.ground);
  const box = new Box3().setFromObject(view.ground);
  log(`street bbox ${box.min.toArray().map((v) => v.toFixed(1))} .. ${box.max.toArray().map((v) => v.toFixed(1))}`);
  view.doors.children.forEach((d) => log(`door ${d.name} ${d.position.toArray().map((v) => v.toFixed(1))}`));
  for (let t = 0; t < 2000; t += 16) view.update?.(t);
  const target = new Vector3(num('tx', 30), num('ty', 0), num('tz', 14));
  const horizon = num('horizon', 0xf2dcc0);
  scene.fog = new Fog(horizon, num('fogn', 40), num('fogf', 120));
  scene.add(sky(num('top', 0x6f9edb), horizon, 0xd8c6ad));
  lights(scene, target, num('shadow', 40));
  if (q.get('clouds') !== '0') {
    const cy = num('cloudy', 14);
    const clouds: [number, number, number, number, number][] = [[-10, cy, -40, 2.2, 3], [12, cy + 4, -55, 2.8, 7], [34, cy + 1, -42, 2.0, 11], [56, cy + 5, -60, 3.0, 19], [76, cy, -45, 2.3, 23]];
    clouds.forEach(([x, y, z, s, sd]) => scene.add(cloud(target.x - 30 + x, y, z, s, sd)));
  }
  const pitch = num('pitch', 20) * Math.PI / 180, yaw = num('yaw', 0) * Math.PI / 180, dist = num('dist', 40);
  const cam = new PerspectiveCamera(num('fov', 30), W / H, 0.5, 900);
  cam.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * Math.cos(pitch) * dist);
  cam.lookAt(target);
  r.render(scene, cam);
  await save(r, q.get('name') ?? 'world.png');
}

const mode = q.get('mode') ?? 'cast';
(mode === 'cast' ? cast() : mode === 'portrait' ? portrait() : world()).then(() => log('DONE'), (e) => log('ERR ' + (e?.stack ?? e)));
