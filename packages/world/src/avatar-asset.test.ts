import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const assetPath = fileURLToPath(
  new URL('../assets/player-sprites/v1/avatar-1.png', import.meta.url),
);
const manifestPath = fileURLToPath(
  new URL('../assets/player-sprites/v1/manifest.json', import.meta.url),
);
const cellQaPath = fileURLToPath(
  new URL('../assets/player-sprites/v1/qa/avatar-1-cosy-six-column/qa-cells.json', import.meta.url),
);
const eyeQaPath = fileURLToPath(
  new URL('../assets/player-sprites/v1/qa/avatar-1-cosy-six-column/eye-anchor-qa.json', import.meta.url),
);

describe('approved Avatar 1 cosy production sheet', () => {
  it('keeps the approved PNG byte-identical with the six-column geometry', () => {
    const bytes = readFileSync(assetPath);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(bytes.readUInt32BE(16)).toBe(384);
    expect(bytes.readUInt32BE(20)).toBe(256);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'f0ea738353723abc18070210bf169002ede62003b03508b1e326ff9ae72e87bb',
    );
  });

  it('records the exact approved column order and scoped QA evidence', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      sheet: {
        defaultMaximumColorsPerFrame?: number;
        perKeyOverrides?: Record<string, unknown>;
      };
    };
    const cells = JSON.parse(readFileSync(cellQaPath, 'utf8')) as Array<{
      alphaValues: number[];
      status: string;
    }>;
    const eye = JSON.parse(readFileSync(eyeQaPath, 'utf8')) as {
      status: string;
      scope: string;
      upRowPixelIdentical: boolean;
      sideRowsRestoredPixelIdentical: boolean;
    };

    expect(manifest.sheet.defaultMaximumColorsPerFrame).toBe(24);
    expect(manifest.sheet.perKeyOverrides?.['avatar-1']).toMatchObject({
      dimensions: [384, 256],
      columns: [
        'idle',
        'contact-left',
        'passing-left',
        'contact-right',
        'passing-right',
        'settle',
      ],
      rows: ['down', 'left', 'right', 'up'],
      sha256: 'f0ea738353723abc18070210bf169002ede62003b03508b1e326ff9ae72e87bb',
      maximumColorsPerFrame: 29,
    });
    expect(cells).toHaveLength(24);
    expect(cells.every((cell) => cell.status === 'pass')).toBe(true);
    expect(cells.every((cell) => JSON.stringify(cell.alphaValues) === '[0,255]')).toBe(true);
    expect(eye).toMatchObject({
      status: 'pass',
      scope: 'avatar-1 cosy down-eye lock; left/right pass reverted',
      upRowPixelIdentical: true,
      sideRowsRestoredPixelIdentical: true,
    });
  });
});
