import { Texture } from 'three';
import type { ImageTextureLoader } from './types.js';

/**
 * Bundled images as textures for the 3D World (D-059).
 *
 * The browser decodes each image through an `<img>` from the document it was
 * given, so builders stay testable in node, where there is no decoder. Only
 * the World's own assets are loaded: Vite emits them next to the bundle, so
 * they share the page's origin. Anything else is refused rather than fetched,
 * which is what keeps a player's address away from a project's CDN.
 */
export function createImageTextureLoader(doc: Document): ImageTextureLoader {
  return {
    load(url) {
      return new Promise<Texture>((resolve, reject) => {
        if (!isOwnAsset(url, doc)) {
          reject(new Error(`The World only loads its own bundled images, not ${url}`));
          return;
        }
        const image = doc.createElement('img');
        image.decoding = 'async';
        image.onload = () => {
          image.onload = image.onerror = null;
          const texture = new Texture(image);
          texture.needsUpdate = true;
          resolve(texture);
        };
        image.onerror = () => {
          image.onload = image.onerror = null;
          reject(new Error(`Could not load the image ${url}`));
        };
        image.src = url;
      });
    },
  };
}

/**
 * Same origin as the page, or inline data: Vite inlines small assets as
 * `data:` URLs and emits the rest beside the bundle. A document whose origin
 * cannot be read admits nothing.
 */
export function isOwnAsset(url: string, doc: Pick<Document, 'baseURI'>): boolean {
  try {
    const base = new URL(doc.baseURI);
    const target = new URL(url, base);
    return target.protocol === 'data:' || target.origin === base.origin;
  } catch {
    return false;
  }
}
