import { CircleGeometry, Mesh, MeshBasicMaterial } from 'three';
import { JUMP_HEIGHT, jumpShadowScale } from '../jump.js';

/**
 * The contact shadow under a jumping avatar (D-097).
 *
 * The sun's shadow map already keeps a jumping figure's shadow on the ground,
 * but from the street camera a figure in the air reads as standing on a
 * taller one. A soft dark disc that stays on the ground and shrinks as the
 * figure rises reads as height. It shows only while the figure is in the air,
 * so standing and walking avatars look exactly as before. Never part of the
 * figure itself: a figure is its seven meshes (D-095).
 */

const RADIUS = 0.34;
const OPACITY = 0.3;
/** Just above whatever the feet stand on, so it never z-fights the ground. */
const GROUND_OFFSET = 0.012;

export interface JumpShadow {
  readonly object: Mesh;
  /**
   * Draw it under feet at `x`, `z` standing on `ground`, for a figure `lift`
   * above it. A lift of 0 hides it.
   */
  place(x: number, ground: number, z: number, lift: number, height?: number): void;
  dispose(): void;
}

export function createJumpShadow(): JumpShadow {
  const geometry = new CircleGeometry(RADIUS, 20).rotateX(-Math.PI / 2);
  const material = new MeshBasicMaterial({ color: 0x14100c, transparent: true, opacity: OPACITY, depthWrite: false });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'avatar:jump-shadow';
  mesh.renderOrder = 1;
  mesh.visible = false;
  return {
    object: mesh,
    place(x, ground, z, lift, height = JUMP_HEIGHT) {
      if (!(lift > 0)) {
        mesh.visible = false;
        return;
      }
      const scale = jumpShadowScale(lift, height);
      mesh.visible = true;
      mesh.position.set(x, ground + GROUND_OFFSET, z);
      mesh.scale.set(scale, 1, scale);
      // Fainter as well as smaller the higher the figure flies.
      material.opacity = OPACITY * (0.55 + 0.45 * scale);
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
