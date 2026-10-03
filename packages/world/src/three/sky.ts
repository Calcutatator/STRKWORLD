import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry } from 'three';

/**
 * The World's sky (D-059): one gradient dome, shared by the game's engine and
 * the title screen's backdrop so both stand under the same golden-hour sky.
 * The brand palette's Sky and Horizon are these colours (D-113).
 */
export const SKY_TOP = 0x6f9edb;
export const SKY_HORIZON = 0xf2dcc0;
/**
 * What lies under the horizon.
 *
 * It used to be a dust colour standing in for land running off past the fog.
 * There is no land any more: the World is a rock floating in the sky (D-132),
 * and everything below its rim is cloud. So the dome's lower half is the
 * cloud sea's own warm white, lit from the same low sun, which is what the far
 * banks of cloud geometry fade into rather than a brown the eye reads as
 * ground.
 */
export const SKY_GROUND = 0xf6e3cb;

/** A gradient dome that follows the camera; cheaper than a sky shader pass. */
export function createSky(): Mesh<SphereGeometry, ShaderMaterial> {
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
