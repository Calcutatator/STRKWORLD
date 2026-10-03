import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

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

/**
 * The dome's own stops between the horizon and the top (D-133, amended
 * 2026-10-03).
 *
 * Two stops were not enough. Sky and Horizon are a cool blue and a warm cream,
 * and a straight crossfade between them passes through **grey**: measured
 * through the engine's own ACES tone mapping, the band from about a tenth to a
 * third of the way up the dome came out at a saturation of 0.01 to 0.06, which
 * is a neutral. That band is most of the frame in any shallow shot — which is
 * why the lookout ride read as weather rather than a golden hour.
 *
 * So the warm end and the cool end are joined *through colour* rather than
 * through the middle of the two: gold on the horizon, a peach just above it,
 * and a soft rose-lilac where the warm hands over to the blue, which is what a
 * low sun actually does to a sky and what the brand's own sky gradient
 * (`--brand-sky-gradient`) paints. Saturation now stays above 0.14 the whole
 * way up. `SKY_TOP` and `SKY_HORIZON` are untouched — they are the brand's
 * Sky and Horizon (D-113) and the engine's fog, and both still read off them.
 *
 * The stops are low on purpose. The shot that reads the sky is the swing's
 * ride, whose frame tops out around a third of the way up the dome, so a blue
 * that only arrives overhead is a blue nobody sees; it is in frame by 0.36.
 * The street and title cameras both look *down* and see almost no sky above
 * the horizon at all, so neither is touched by what happens up there.
 */
export const SKY_GOLD = 0xf7cf94;
export const SKY_PEACH = 0xf3ad83;
export const SKY_ROSE = 0xc79cc6;
/** Where each stop sits, as a fraction of the way from the horizon to straight up. */
export const SKY_PEACH_HEIGHT = 0.06;
export const SKY_ROSE_HEIGHT = 0.16;
export const SKY_TOP_HEIGHT = 0.36;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The dome's colour looking `h` of the way up (1 straight up, -1 straight
 * down), in the renderer's own working space — the same arithmetic the shader
 * below does, so a test or an offline rasterizer can ask what the sky is
 * without re-stating the gradient and drifting from it.
 */
export function skyColourAt(h: number): Color {
  const height = Number.isFinite(h) ? Math.max(-1, Math.min(1, h)) : 0;
  const gold = new Color(SKY_GOLD);
  if (height < 0) {
    return gold.lerp(new Color(SKY_GROUND), Math.pow(-height, 0.45));
  }
  const colour = gold.lerp(new Color(SKY_PEACH), smoothstep(0, SKY_PEACH_HEIGHT, height));
  colour.lerp(new Color(SKY_ROSE), smoothstep(SKY_PEACH_HEIGHT, SKY_ROSE_HEIGHT, height));
  colour.lerp(new Color(SKY_TOP), smoothstep(SKY_ROSE_HEIGHT, SKY_TOP_HEIGHT, height));
  return colour;
}

/** A gradient dome that follows the camera; cheaper than a sky shader pass. */
export function createSky(): Mesh<SphereGeometry, ShaderMaterial> {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new Color(SKY_TOP) },
      horizon: { value: new Color(SKY_GOLD) },
      peach: { value: new Color(SKY_PEACH) },
      rose: { value: new Color(SKY_ROSE) },
      stops: { value: new Vector3(SKY_PEACH_HEIGHT, SKY_ROSE_HEIGHT, SKY_TOP_HEIGHT) },
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
      uniform vec3 peach;
      uniform vec3 rose;
      uniform vec3 stops;
      uniform vec3 below;
      varying vec3 vDirection;
      void main() {
        float h = vDirection.y;
        vec3 up = mix(horizon, peach, smoothstep(0.0, stops.x, h));
        up = mix(up, rose, smoothstep(stops.x, stops.y, h));
        up = mix(up, top, smoothstep(stops.y, stops.z, h));
        vec3 colour = h >= 0.0
          ? up
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
