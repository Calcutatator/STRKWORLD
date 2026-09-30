// three ships this module's source but no declaration for it. The offline
// walker render (avatar-walker.ts) reads the same DFG table the r186 WebGL
// renderer binds as `dfgLUT` for MeshStandardMaterial.
declare module 'three/src/renderers/shaders/DFGLUTData.js' {
  import type { DataTexture } from 'three';

  /** 16 x 16 RG half floats: the split-sum scale and bias per (roughness, N·V). */
  export function getDFGLUT(): DataTexture;
}
