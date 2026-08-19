import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const assetDirectory = fileURLToPath(
  new URL('../assets/third-party/kenney-rpg-urban/', import.meta.url),
);
const creditsPath = fileURLToPath(new URL('../assets/CREDITS.md', import.meta.url));

function readAsset(name: string): Buffer {
  const path = `${assetDirectory}${name}`;
  expect(existsSync(path), `${name} must be present in the credited asset slice`).toBe(true);
  return readFileSync(path);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('Kenney RPG Urban provenance slice', () => {
  it('keeps the credited source files byte-identical and self-describing', () => {
    const atlas = readAsset('tilemap.png');
    const metadata = readAsset('tilemap.txt').toString('utf8');
    const license = readAsset('License.txt').toString('utf8');
    expect(existsSync(creditsPath), 'assets/CREDITS.md must record this import').toBe(true);
    const credits = readFileSync(creditsPath, 'utf8');

    // PNG IHDR width/height are fixed-width fields; no image-processing package
    // is needed just to guard the acquired source dimensions.
    expect(atlas.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(atlas.readUInt32BE(16)).toBe(458);
    expect(atlas.readUInt32BE(20)).toBe(305);
    expect(sha256(atlas)).toBe(
      'c2a4b6c58587a39cef78553347d6d2b51ec6820efb9945fd548c68a0b50cafe0',
    );
    expect(sha256(Buffer.from(metadata))).toBe(
      'fa8ecb82faa1b990dab06085f39dbba3dbb42699651bddca0acd4250feb4be9c',
    );
    expect(sha256(Buffer.from(license))).toBe(
      '912065f2d428a62fa4e7b337d292f9eee26051eece4182661cff40310a54f7fa',
    );
    expect(metadata).toContain('Tile width :\t16px');
    expect(metadata).toContain('Tile height:\t16px');
    expect(metadata).toContain('Spacing:\t1px');
    expect(license).toContain('License: (Creative Commons Zero, CC0)');
    expect(license).toContain('free to use in personal, educational and commercial projects');
    expect(credits).toContain('tilemap.png');
    expect(credits).toContain('No modifications');
  });
});
