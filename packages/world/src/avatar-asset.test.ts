import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
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
const parityPath = fileURLToPath(
  new URL('../assets/player-sprites/v1/qa/avatar-1-cosy-six-column/sheet-crop-parity.json', import.meta.url),
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
      status?: string;
      sheet: {
        defaultMaximumColorsPerFrame?: number;
        perKeyOverrides?: Record<string, unknown>;
      };
      reviewState?: { runtimeReady?: boolean; renderedAcceptance?: boolean };
    };
    const cells = JSON.parse(readFileSync(cellQaPath, 'utf8')) as Array<{
      file: string;
      alphaValues: number[];
      status: string;
    }>;
    const eye = JSON.parse(readFileSync(eyeQaPath, 'utf8')) as {
      status: string;
      scope: string;
      upRowPixelIdentical: boolean;
      sideRowsRestoredPixelIdentical: boolean;
    };
    const parity = JSON.parse(readFileSync(parityPath, 'utf8')) as {
      sourceSha256: string;
      cells: Array<{ cell: string; row: string; column: string; rgbaSha256: string }>;
    };

    expect(manifest).toMatchObject({
      status: 'runtime-integrated-rendered-acceptance-pending',
      reviewState: { runtimeReady: true, renderedAcceptance: false },
    });
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
    expect(cells.every((cell) => !cell.file.includes('/'))).toBe(true);
    expect(parity.sourceSha256).toBe(
      'f0ea738353723abc18070210bf169002ede62003b03508b1e326ff9ae72e87bb',
    );
    const decoded = decodeRgbaPng(readFileSync(assetPath));
    expect(decoded).toMatchObject({ width: 384, height: 256 });
    expect(parity.cells).toHaveLength(24);
    expect(new Set(parity.cells.map(({ cell }) => cell))).toEqual(
      new Set(cells.map(({ file }) => file)),
    );
    for (const record of parity.cells) {
      const row = ['down', 'left', 'right', 'up'].indexOf(record.row);
      const column = [
        'idle',
        'contact-left',
        'passing-left',
        'contact-right',
        'passing-right',
        'settle',
      ].indexOf(record.column);
      expect(row, record.cell).toBeGreaterThanOrEqual(0);
      expect(column, record.cell).toBeGreaterThanOrEqual(0);
      expect(createHash('sha256').update(cropRgba(decoded, column, row)).digest('hex')).toBe(
        record.rgbaSha256,
      );
    }
    expect(eye).toMatchObject({
      status: 'pass',
      scope: 'avatar-1 cosy down-eye lock; left/right pass reverted',
      upRowPixelIdentical: true,
      sideRowsRestoredPixelIdentical: true,
    });
  });
});

function decodeRgbaPng(bytes: Buffer): { width: number; height: number; pixels: Buffer } {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      expect([...chunk.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0]);
    } else if (type === 'IDAT') {
      data.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const filtered = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  expect(filtered).toHaveLength((stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[y * (stride + 1) + x + 1]!;
      const left = x >= 4 ? pixels[y * stride + x - 4]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4]! : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
        : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2)
        : filter === 4 ? paeth(left, up, upLeft)
        : -1;
      expect(predictor, `unsupported PNG filter ${filter}`).toBeGreaterThanOrEqual(0);
      pixels[y * stride + x] = (raw + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

function cropRgba(
  image: { width: number; pixels: Buffer },
  column: number,
  row: number,
): Buffer {
  const crop = Buffer.alloc(64 * 64 * 4);
  for (let y = 0; y < 64; y += 1) {
    const start = ((row * 64 + y) * image.width + column * 64) * 4;
    image.pixels.copy(crop, y * 64 * 4, start, start + 64 * 4);
  }
  return crop;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}
