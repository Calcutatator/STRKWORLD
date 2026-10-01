/**
 * Headless cost of drawing other players: the real remote-avatar layer and
 * the real avatar figures, without a GPU.
 *
 *   node --expose-gc --max-semi-space-size=64 --import tsx \
 *     packages/world/tools/remote-crowd-bench.ts [--interpolation]
 *
 * For 10, 24 (the lobby's per-observer cap), 50 and 100 figures it reports
 * what the renderer would be handed — draw calls (visible meshes), shadow
 * caster draws, triangles, distinct geometries and materials — and what one
 * frame of the layer costs on the CPU: `update()` time and heap allocated
 * per frame, with every figure walking and a lobby snapshot published every
 * 50 ms as on the street.
 *
 * `--interpolation` instead walks one figure in a straight line at the
 * game's walk speed and reports how even its drawn speed is, frame to frame,
 * when patches arrive on time, with every third one missing (a move the
 * server dropped) and with 20 ms of arrival jitter. A perfectly smooth walk
 * is a coefficient of variation of 0.
 *
 * What this cannot measure: GPU time, shader cost, the browser's own frame
 * pacing, fill rate, or WebGL driver overhead per draw call. Draw-call and
 * triangle counts are the inputs to those, read from the scene graph.
 */

import { Mesh, type Object3D } from 'three';
import { createRemotePeerSource, type RemotePeerSnapshot } from '../src/remote-peer.js';
import { createAvatarFigure } from '../src/three/avatar-figure.js';
import { createRemoteAvatarLayer3D } from '../src/three/remote-avatars.js';
import { PIXELS_PER_UNIT } from '../src/three/coords.js';

const gc = (globalThis as { gc?: () => void }).gc;
const FRAME_MS = 1000 / 60;
const PATCH_MS = 50;
const WALK = 160;
const SPRITES = ['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4', 'avatar-5', 'avatar-6', 'avatar-7', 'avatar-8'];

function sceneStats(root: Object3D): Record<string, number> {
  let meshes = 0;
  let shadowCasters = 0;
  let triangles = 0;
  const geometries = new Set<unknown>();
  const materials = new Set<unknown>();
  root.traverseVisible((object) => {
    if (!(object instanceof Mesh)) return;
    meshes += 1;
    if (object.castShadow) shadowCasters += 1;
    const geometry = object.geometry;
    geometries.add(geometry);
    const materialList = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materialList) materials.add(material);
    const count = geometry.index ? geometry.index.count : (geometry.getAttribute('position')?.count ?? 0);
    triangles += count / 3;
  });
  return { meshes, shadowCasters, triangles, geometries: geometries.size, materials: materials.size };
}

function crowdSnapshot(count: number, t: number): RemotePeerSnapshot[] {
  const peers: RemotePeerSnapshot[] = [];
  for (let index = 0; index < count; index += 1) {
    // Everyone walks a circle, so every figure is always moving.
    const angle = (t / 1000) * (WALK / 300) + index;
    peers.push({
      id: `peer${index}`,
      x: Math.round(3000 + Math.cos(angle) * 300 + (index % 10) * 40),
      y: Math.round(400 + Math.sin(angle) * 300 + Math.floor(index / 10) * 40),
      facing: 'right',
      sprite: SPRITES[index % SPRITES.length] as string,
      carrying: null,
    });
  }
  return peers;
}

function crowd(count: number): Record<string, number> {
  const controller = createRemotePeerSource();
  const layer = createRemoteAvatarLayer3D({ source: controller.source, figures: createAvatarFigure });
  let t = 0;
  let sincePatch = PATCH_MS;
  const step = (): void => {
    t += FRAME_MS;
    sincePatch += FRAME_MS;
    if (sincePatch >= PATCH_MS) {
      sincePatch -= PATCH_MS;
      controller.publish(crowdSnapshot(count, t));
    }
    layer.update(FRAME_MS);
  };
  // Warm up: build every figure, settle the JIT.
  for (let frame = 0; frame < 600; frame += 1) step();
  const stats = sceneStats(layer.group);

  const frames = 1200;
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  for (let frame = 0; frame < frames; frame += 1) step();
  const elapsed = performance.now() - start;
  const heapAfter = process.memoryUsage().heapUsed;
  layer.destroy();
  controller.clear();
  return {
    figures: count,
    ...stats,
    frameMs: elapsed / frames,
    allocatedBytesPerFrame: Math.max(0, heapAfter - heapBefore) / frames,
  };
}

function walkSmoothness(mode: 'on-time' | 'drop-every-third' | 'jitter-20ms'): Record<string, number | string> {
  const controller = createRemotePeerSource();
  const layer = createRemoteAvatarLayer3D({ source: controller.source, figures: createAvatarFigure });
  let seed = 7;
  const random = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  // The server's copy of the walker: a new position every 50 ms send.
  const sendTimes: number[] = [];
  for (let at = 0; at < 6000; at += PATCH_MS) sendTimes.push(at);
  const arrivals = sendTimes
    .map((at, index) => ({
      at: mode === 'jitter-20ms' ? at + random() * 20 : at,
      x: 1000 + (WALK * at) / 1000,
      dropped: mode === 'drop-every-third' && index % 3 === 2,
    }))
    .filter((arrival) => !arrival.dropped);
  // Patches go out every 50 ms carrying whatever arrived since the last.
  const speeds: number[] = [];
  let next = 0;
  let current = arrivals[0]?.x ?? 1000;
  let lastDrawn: number | null = null;
  let patchClock = 0;
  for (let t = 0; t < 6000; t += FRAME_MS) {
    if (t >= patchClock) {
      patchClock += PATCH_MS;
      while (next < arrivals.length && (arrivals[next] as { at: number }).at <= t) {
        current = (arrivals[next] as { x: number }).x;
        next += 1;
      }
      controller.publish([{ id: 'walker', x: Math.round(current), y: 400, facing: 'right', sprite: 'avatar-1', carrying: null }]);
    }
    layer.update(FRAME_MS);
    const object = layer.group.children[0];
    if (object === undefined) continue;
    const drawn = object.position.x * PIXELS_PER_UNIT;
    if (lastDrawn !== null && t > 1000 && t < 5500) speeds.push(((drawn - lastDrawn) / FRAME_MS) * 1000);
    lastDrawn = drawn;
  }
  layer.destroy();
  const mean = speeds.reduce((total, speed) => total + speed, 0) / speeds.length;
  const sd = Math.sqrt(speeds.reduce((total, speed) => total + (speed - mean) ** 2, 0) / speeds.length);
  const sorted = [...speeds].sort((a, b) => a - b);
  return {
    mode,
    meanSpeed: mean,
    cv: sd / mean,
    p5Speed: sorted[Math.floor(sorted.length * 0.05)] as number,
    p95Speed: sorted[Math.floor(sorted.length * 0.95)] as number,
  };
}

if (process.argv.includes('--interpolation')) {
  for (const mode of ['on-time', 'drop-every-third', 'jitter-20ms'] as const) {
    const result = walkSmoothness(mode);
    process.stdout.write(
      `${String(result['mode']).padEnd(18)} drawn speed mean ${(result['meanSpeed'] as number).toFixed(1)} px/s  ` +
        `p5 ${(result['p5Speed'] as number).toFixed(1)}  p95 ${(result['p95Speed'] as number).toFixed(1)}  ` +
        `CV ${(result['cv'] as number).toFixed(3)}\n`,
    );
  }
} else {
  if (gc === undefined) process.stdout.write('(run with --expose-gc for allocation figures)\n');
  for (const count of [10, 24, 50, 100]) {
    const result = crowd(count);
    process.stdout.write(
      `${String(count).padStart(3)} figures: ${result['meshes']} draw calls + ${result['shadowCasters']} shadow draws, ` +
        `${result['triangles']} triangles, ${result['geometries']} geometries, ${result['materials']} material(s); ` +
        `update ${(result['frameMs'] as number).toFixed(3)} ms/frame, ` +
        `${((result['allocatedBytesPerFrame'] as number) / 1024).toFixed(1)} KB allocated/frame\n`,
    );
  }
}
process.exit(0);
