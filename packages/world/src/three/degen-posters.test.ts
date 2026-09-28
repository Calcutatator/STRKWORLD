import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { DEGEN_TOKENS } from './palette.js';
import { createImageTextureLoader, isOwnAsset } from './image-textures.js';

/**
 * The Degen floor's posters are the projects' own art, bundled with the World
 * (assets/CREDITS.md). These tests pin what ships and how it loads; the room
 * builder's tests cover how a poster hangs, fades, falls back and disposes.
 */

const POSTERS = fileURLToPath(new URL('../../assets/degen-posters/', import.meta.url));
const CREDITS = fileURLToPath(new URL('../../assets/CREDITS.md', import.meta.url));
/** Eight of these ship with the World: small enough to carry, big enough to read. */
const MAX_POSTER_BYTES = 150 * 1024;

/** A WebP's canvas size from its header (lossy, lossless or extended), or null if it is not one. */
function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  switch (bytes.toString('latin1', 12, 16)) {
    case 'VP8 ':
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    case 'VP8L': {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X':
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    default:
      return null;
  }
}

describe('the Degen floor posters', () => {
  it('ship as one bundled 512 by 768 WebP per token, each within budget', () => {
    const files: string[] = [];
    for (const token of DEGEN_TOKENS) {
      // In node the bundler's URL is the file itself; in the browser it is the game's own origin.
      const url = new URL(token.poster);
      expect(url.protocol, token.ticker).toBe('file:');
      const path = fileURLToPath(url);
      expect(dirname(path) + sep, token.ticker).toBe(POSTERS);
      const bytes = readFileSync(path);
      expect(bytes.length, token.ticker).toBeLessThanOrEqual(MAX_POSTER_BYTES);
      // A whole file: the RIFF length covers every byte.
      expect(bytes.readUInt32LE(4) + 8, token.ticker).toBe(bytes.length);
      expect(webpSize(bytes), token.ticker).toEqual({ width: 512, height: 768 });
      files.push(path);
    }
    expect(new Set(files).size).toBe(DEGEN_TOKENS.length);
    // Nothing else ships from that folder: no source SVG, no stray download.
    expect(readdirSync(POSTERS).map((name) => join(POSTERS, name)).sort()).toEqual([...files].sort());
  });

  it('are each credited to their project, with their sources', () => {
    const credits = readFileSync(CREDITS, 'utf8');
    for (const token of DEGEN_TOKENS) {
      const file = new URL(token.poster).pathname.split('/').at(-1)!;
      expect(credits, token.ticker).toContain(`degen-posters/${file}`);
      expect(credits, token.ticker).toContain(token.ticker);
    }
  });
});

describe('createImageTextureLoader', () => {
  interface FakeImage {
    src: string;
    decoding: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
  }
  function fakeDocument(baseURI: string) {
    const images: FakeImage[] = [];
    const createElement = vi.fn((_tag: string): FakeImage => {
      const image: FakeImage = { src: '', decoding: '', onload: null, onerror: null };
      images.push(image);
      return image;
    });
    return { doc: { baseURI, createElement } as unknown as Document, images, createElement };
  }

  it('decodes the World\'s own bundled images into textures', async () => {
    const { doc, images, createElement } = fakeDocument('https://strkworld.example/play/');
    const pending = createImageTextureLoader(doc).load('/assets/lords-3f2a.webp');
    expect(createElement).toHaveBeenCalledWith('img');
    expect(images[0]!.src).toBe('/assets/lords-3f2a.webp');
    expect(images[0]!.decoding).toBe('async');
    images[0]!.onload!();
    const texture = await pending;
    expect(texture).toBeInstanceOf(Texture);
    expect(texture.image).toBe(images[0]);
    // Marked for upload, and the image lets go of its handlers.
    expect(texture.version).toBeGreaterThan(0);
    expect(images[0]!.onload).toBeNull();
  });

  it('rejects an image that does not load', async () => {
    const { doc, images } = fakeDocument('https://strkworld.example/');
    const pending = createImageTextureLoader(doc).load('https://strkworld.example/assets/missing.webp');
    images[0]!.onerror!();
    await expect(pending).rejects.toThrow(/Could not load/);
  });

  it('refuses a third-party image without ever requesting it', async () => {
    const { doc, createElement } = fakeDocument('https://strkworld.example/');
    const loader = createImageTextureLoader(doc);
    for (const url of [
      'https://assets.coingecko.com/coins/images/22171/large/Frame_1.png',
      '//i.imgur.com/mSywi47.png',
      'http://strkworld.example/assets/lords.webp',
      'https://strkworld.example.evil.test/assets/lords.webp',
    ]) {
      await expect(loader.load(url), url).rejects.toThrow(/own bundled images/);
    }
    expect(createElement).not.toHaveBeenCalled();
  });

  it('admits only same-origin and inline images, and nothing when the origin is unknown', () => {
    const page = { baseURI: 'https://strkworld.example/play/' };
    expect(isOwnAsset('/assets/dog-1a.webp', page)).toBe(true);
    expect(isOwnAsset('assets/dog-1a.webp', page)).toBe(true);
    expect(isOwnAsset('https://strkworld.example/assets/dog-1a.webp', page)).toBe(true);
    expect(isOwnAsset('data:image/webp;base64,UklGRg==', page)).toBe(true);
    expect(isOwnAsset('https://dogofbitcoin.com/dog_logo.png', page)).toBe(false);
    expect(isOwnAsset('//dogofbitcoin.com/dog_logo.png', page)).toBe(false);
    expect(isOwnAsset('/assets/dog-1a.webp', { baseURI: undefined as unknown as string })).toBe(false);
  });
});
