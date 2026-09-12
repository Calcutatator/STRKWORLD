#!/usr/bin/env node
'use strict';

// Analysis-only resampling of the original approved concept. No runtime or
// rejected sprite is read. No pixels are drawn to invent anatomy or details.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const ROOT = __dirname;
const SOURCE = path.resolve(ROOT, '../approved-concept-turnaround.png');
const DIRECTIONS = ['down', 'right', 'left', 'up']; // Actual source image order.
const METHODS = ['nearest', 'area', 'dominant-24', 'nearest-24'];
const SELECTION = {
  down: { method: 'nearest-24', phaseX: 0.375, phaseY: -0.375 },
  right: { method: 'nearest-24', phaseX: 0.375, phaseY: -0.375 },
  left: { method: 'nearest-24', phaseX: 0, phaseY: -0.375 },
  up: { method: 'dominant-24', phaseX: 0, phaseY: 0 },
};
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const rgbDistance = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const toHex = (color) => '#' + color.map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
const png = (bytes, width, height) => sharp(bytes, { raw: { width, height, channels: 4 } }).png().toBuffer();

function nearestColor(color, palette) {
  let best = 0, distance = Infinity;
  palette.forEach((candidate, index) => { const d = rgbDistance(color, candidate); if (d < distance) { best = index; distance = d; } });
  return best;
}

function palette24(pixels) {
  // Deterministic weighted k-means over a 5-bit-per-channel histogram. Final
  // medoids are actual colors sampled from this concept, never invented hues.
  const histogram = new Map();
  for (const color of pixels) {
    const key = color.map((v) => v >> 3).join(',');
    const entry = histogram.get(key) || { count: 0, sums: [0, 0, 0], first: color };
    entry.count++; color.forEach((v, i) => entry.sums[i] += v); histogram.set(key, entry);
  }
  const samples = [...histogram.values()].map((e) => ({ color: e.sums.map((sum) => sum / e.count), count: e.count }));
  let palette = [samples.reduce((a, b) => a.color.reduce((x, y) => x + y) < b.color.reduce((x, y) => x + y) ? a : b).color];
  while (palette.length < 24) {
    let chosen = samples[0], score = -1;
    for (const sample of samples) {
      const candidate = Math.min(...palette.map((color) => rgbDistance(sample.color, color))) * Math.sqrt(sample.count);
      if (candidate > score) { score = candidate; chosen = sample; }
    }
    palette.push(chosen.color);
  }
  for (let round = 0; round < 24; round++) {
    const groups = palette.map(() => ({ sum: [0, 0, 0], weight: 0 }));
    for (const sample of samples) {
      const group = groups[nearestColor(sample.color, palette)];
      sample.color.forEach((v, i) => group.sum[i] += v * sample.count); group.weight += sample.count;
    }
    palette = groups.map((group, index) => group.weight ? group.sum.map((v) => v / group.weight) : palette[index]);
  }
  return palette.map((center) => {
    let best = pixels[0], distance = Infinity;
    for (const color of pixels) { const d = rgbDistance(color, center); if (d < distance) { best = color; distance = d; } }
    return best;
  }).sort((a, b) => a.reduce((x, y) => x + y) - b.reduce((x, y) => x + y));
}

async function main() {
  const source = await fs.readFile(SOURCE);
  const decoded = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = decoded.info;
  const raw = decoded.data;
  function floodExterior(minimum, chroma) {
    const exteriorBackground = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let tail = 0;
    const neutral = (pixel) => {
      const offset = pixel * 4;
      const values = [raw[offset], raw[offset + 1], raw[offset + 2]];
      return raw[offset + 3] <= 127 || (Math.min(...values) >= minimum && Math.max(...values) - Math.min(...values) <= chroma);
    };
    const enqueue = (pixel) => {
      if (!exteriorBackground[pixel] && neutral(pixel)) {
        exteriorBackground[pixel] = 1; queue[tail++] = pixel;
      }
    };
    for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
    for (let head = 0; head < tail; head++) {
      const pixel = queue[head], x = pixel % width, y = Math.floor(pixel / width);
      if (x > 0) enqueue(pixel - 1); if (x < width - 1) enqueue(pixel + 1);
      if (y > 0) enqueue(pixel - width); if (y < height - 1) enqueue(pixel + width);
    }
    return exteriorBackground;
  }
  // Keep the original study's registration when tightening matte removal.
  // Otherwise a removed fringe pixel changes scale/phase and shifts the eyes.
  const framingBackground = floodExterior(222, 24);
  const exteriorBackground = floodExterior(50, 28);
  const framingForeground = (x, y) => raw[(y * width + x) * 4 + 3] > 127 && !framingBackground[y * width + x];
  const foreground = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    return raw[(y * width + x) * 4 + 3] > 127 && !exteriorBackground[y * width + x];
  };
  const read = (x, y) => {
    if (!foreground(x, y)) return null;
    const offset = (y * width + x) * 4; return [...raw.subarray(offset, offset + 3)];
  };
  const figures = DIRECTIONS.map((direction, i) => {
    const bounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
    for (let y = 0; y < height; y++) for (let x = Math.floor(i * width / 4); x < Math.floor((i + 1) * width / 4); x++) {
      if (!framingForeground(x, y)) continue;
      bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
    }
    if (bounds.maxX < 0) throw new Error(`Empty source figure ${direction}`);
    const bootXs = [];
    for (let y = bounds.maxY - 5; y <= bounds.maxY; y++) for (let x = bounds.minX; x <= bounds.maxX; x++) if (framingForeground(x, y)) bootXs.push(x);
    const feetX = (Math.min(...bootXs) + Math.max(...bootXs) + 1) / 2;
    return { direction, ...bounds, feetX, footBottomEdge: bounds.maxY + 1 };
  });
  const scale = (figures[0].maxY - figures[0].minY + 1) / 50;
  const sourcePixels = [];
  for (const figure of figures) for (let y = figure.minY; y <= figure.maxY; y++) for (let x = figure.minX; x <= figure.maxX; x++) {
    const color = read(x, y); if (color) sourcePixels.push(color);
  }
  const palette = palette24(sourcePixels);
  await fs.writeFile(path.join(ROOT, 'concept-palette-24.json'), JSON.stringify({ source: '../approved-concept-turnaround.png',
    construction: 'Weighted k-means; medoids selected from actual foreground source pixels; common palette across all directions',
    colors: palette.map((color, i) => ({ name: `concept-${String(i + 1).padStart(2, '0')}`, hex: toHex(color) })) }, null, 2) + '\n');

  function sample(figure, method, phaseX = 0, phaseY = 0) {
    const output = Buffer.alloc(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      // x=32 registers the midpoint of the source's boot support span. The
      // phase-aligned raster is translated afterward so its last support row
      // is exactly y=55 (bottom edge y=56); no silhouette-height normalization.
      const left = figure.feetX + (x - 32 + phaseX) * scale;
      const top = figure.footBottomEdge + (y - 57 + phaseY) * scale;
      let color = null;
      if (method.startsWith('nearest')) {
        color = read(Math.floor(left + scale / 2), Math.floor(top + scale / 2));
        if (color && method === 'nearest-24') color = palette[nearestColor(color, palette)];
      } else {
        let coverage = 0, sum = [0, 0, 0];
        const counts = Array(palette.length).fill(0);
        for (let sy = Math.floor(top); sy < Math.ceil(top + scale); sy++) for (let sx = Math.floor(left); sx < Math.ceil(left + scale); sx++) {
          const weight = Math.max(0, Math.min(sx + 1, left + scale) - Math.max(sx, left)) * Math.max(0, Math.min(sy + 1, top + scale) - Math.max(sy, top));
          const value = read(sx, sy); if (!value) continue;
          coverage += weight;
          value.forEach((v, channel) => sum[channel] += v * weight);
          if (method === 'dominant-24') counts[nearestColor(value, palette)] += weight;
        }
        if (coverage >= scale * scale * 0.5) {
          color = method === 'area' ? sum.map((v) => Math.round(v / coverage)) : palette[counts.indexOf(Math.max(...counts))];
        }
      }
      if (color) { const offset = (y * 64 + x) * 4; color.forEach((value, i) => output[offset + i] = value); output[offset + 3] = 255; }
    }
    return output;
  }

  function registerSupport(bytes) {
    let bottom = -1;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (bytes[(y * 64 + x) * 4 + 3]) bottom = y;
    if (bottom < 0) throw new Error('Empty sampled image');
    const translateY = 55 - bottom, registered = Buffer.alloc(bytes.length);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const at = (y * 64 + x) * 4, targetY = y + translateY;
      if (!bytes[at + 3]) continue;
      if (targetY < 0 || targetY >= 64) throw new Error('Registration would clip the source silhouette');
      bytes.copy(registered, (targetY * 64 + x) * 4, at, at + 4);
    }
    return { registered, translateY, sampledBottomRow: bottom };
  }

  function metric(bytes) {
    const opaque = [], colors = new Set();
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const at = (y * 64 + x) * 4;
      if (bytes[at + 3]) { opaque.push([x, y]); colors.add(bytes.subarray(at, at + 3).toString('hex')); } }
    return { colors: colors.size, binaryAlpha: true, partialAlphaPixels: 0,
      visibleHeight: Math.max(...opaque.map((v) => v[1])) - Math.min(...opaque.map((v) => v[1])) + 1,
      bounds: [Math.min(...opaque.map((v) => v[0])), Math.min(...opaque.map((v) => v[1])), Math.max(...opaque.map((v) => v[0])), Math.max(...opaque.map((v) => v[1]))] };
  }

  const records = [], previews = [], selected = [], rawCrops = [];
  for (const figure of figures) {
    const cropped = await sharp(source).extract({ left: figure.minX, top: figure.minY,
      width: figure.maxX - figure.minX + 1, height: figure.maxY - figure.minY + 1 }).png().toBuffer();
    await fs.writeFile(path.join(ROOT, `${figure.direction}-raw-concept-crop.png`), cropped);
    rawCrops.push({ direction: figure.direction, filename: `${figure.direction}-raw-concept-crop.png`, sha256: hash(cropped),
      sourceRectangle: [figure.minX, figure.minY, figure.maxX - figure.minX + 1, figure.maxY - figure.minY + 1] });
    for (const method of METHODS) {
      const { registered: bytes } = registerSupport(sample(figure, method));
      const image = await png(bytes, 64, 64);
      records.push({ direction: figure.direction, method, rgbaSha256: hash(bytes), ...metric(bytes) });
      previews.push({ direction: figure.direction, method, image });
    }
    const choice = SELECTION[figure.direction];
    const registered = registerSupport(sample(figure, choice.method, choice.phaseX, choice.phaseY));
    const image = await png(registered.registered, 64, 64), filename = `${figure.direction}-construction-64.png`;
    await fs.writeFile(path.join(ROOT, filename), image);
    selected.push({ direction: figure.direction, ...choice, integerTranslateY: registered.translateY,
      sampledBottomRow: registered.sampledBottomRow, finalBottomRow: 55, filename, sha256: hash(image),
      rgbaSha256: hash(registered.registered), ...metric(registered.registered) });
    previews.push({ direction: figure.direction, method: 'selected', image });
  }

  const boardWidth = 1320, boardHeight = 2050;
  let markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${boardWidth}" height="${boardHeight}"><rect width="100%" height="100%" fill="#F6F3E9"/><g font-family="Arial,sans-serif" fill="#253B35"><text x="28" y="45" font-size="24" font-weight="700">Original-concept sampling study · 50px target</text><text x="28" y="75" font-size="15">Source only. One common scale; actual cleaned silhouettes 49px. Support bottom edge (32,56), last opaque row 55.</text>`;
  const labels = ['RAW CONCEPT CROP', 'NEAREST ALIGNED', 'AREA AVERAGE', 'DOMINANT / 24', 'SELECTED / 24'];
  labels.forEach((label, i) => markup += `<text x="${28 + i * 258}" y="112" font-size="14" font-weight="700">${label}</text>`);
  const composites = [];
  for (let row = 0; row < DIRECTIONS.length; row++) {
    const y = 142 + row * 376, direction = DIRECTIONS[row];
    markup += `<text x="28" y="${y}" font-size="17" font-weight="700">${direction.toUpperCase()}</text>`;
    const crop = await fs.readFile(path.join(ROOT, `${direction}-raw-concept-crop.png`));
    composites.push({ input: await sharp(crop).resize({ width: 240, height: 300, fit: 'inside', kernel: 'nearest' }).png().toBuffer(), left: 28, top: y + 16 });
    for (let col = 0; col < 4; col++) {
      const method = ['nearest', 'area', 'dominant-24', 'selected'][col];
      const left = 286 + col * 258, image = previews.find((p) => p.direction === direction && p.method === method).image;
      markup += `<rect x="${left}" y="${y + 16}" width="256" height="256" fill="#E0E3D6"/><rect x="${left + 96}" y="${y + 282}" width="64" height="64" fill="#E0E3D6"/>`;
      composites.push({ input: await sharp(image).resize(256, 256, { kernel: 'nearest' }).png().toBuffer(), left, top: y + 16 },
        { input: image, left: left + 96, top: y + 282 });
    }
  }
  markup += '<text x="28" y="1665" font-size="19" font-weight="700">Face construction · source evidence and exact output pixels</text><text x="28" y="1695" font-size="15">Original concept crop</text><text x="430" y="1695" font-size="15">Selected sampling phase x +0.375 / y -0.375</text><text x="814" y="1695" font-size="15">Dominant-24 comparison</text><text x="28" y="2030" font-size="15">Study only: aesthetic approval, vector reconstruction and game acceptance remain separate.</text>';
  composites.push({ input: await sharp(source).extract({ left: 275, top: 330, width: 90, height: 72 }).resize(360, 288, { kernel: 'nearest' }).png().toBuffer(), left: 28, top: 1716 });
  for (const [method, left] of [['selected', 430], ['dominant-24', 814]]) {
    const image = previews.find((p) => p.direction === 'down' && p.method === method).image;
    composites.push({ input: await sharp(image).extract({ left: 25, top: 15, width: 14, height: 12 }).resize(336, 288, { kernel: 'nearest' }).png().toBuffer(), left, top: 1716 });
  }
  markup += '</g></svg>';
  const board = await sharp(Buffer.from(markup)).composite(composites).png().toBuffer();
  await fs.writeFile(path.join(ROOT, 'concept-sampling-comparison.png'), board);

  // Phase variants were diagnostic only. Retain no temporary candidate cells
  // or boards from earlier runs; the four chosen cells are the construction
  // handoff, while the final comparison board preserves method evidence.
  const phaseValues = [-0.375, -0.125, 0.125, 0.375];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    await fs.rm(path.join(ROOT, `down-phase-x${phaseValues[col]}-y${phaseValues[row]}.png`), { force: true });
  }
  for (const direction of DIRECTIONS) for (const method of METHODS) await fs.rm(path.join(ROOT, `${direction}-${method}-64.png`), { force: true });
  for (const filename of ['down-sampling-phase-study.png', 'down-source-face-inspection.png']) await fs.rm(path.join(ROOT, filename), { force: true });
  await fs.writeFile(path.join(ROOT, 'study.json'), JSON.stringify({ status: 'construction study only; not a replacement asset or approval',
    source: '../approved-concept-turnaround.png', sourceSha256: hash(source), scriptSha256: hash(await fs.readFile(__filename)),
    sourceDimensions: [width, height], sourceOrder: DIRECTIONS, gameOrder: ['down', 'left', 'right', 'up'],
    backgroundRule: '4-connected flood fill from image borders through neutral pixels (minimum RGB >= 50 and RGB range <= 28). Only exterior flood becomes transparent, including gray antialias fringe; enclosed white eye sclera and the dark outline remain opaque. No foreground recoloring before sampling.',
    framingMask: 'Original study bounds/boot anchor retained from exterior-neutral-bright flood at minimum RGB >= 222 and RGB range <= 24. Tightening gray-fringe removal does not change scale or sampling phase.',
    figureBounds: figures, sourcePixelsPerOutputPixel: scale, targetDownVisibleHeight: 50, feetPivot: [32, 56],
    alignment: 'All views share down-derived scale. Boot-span midpoint maps to x32, with recorded sampling phase. Each initial raster is translated by an integer offset to bottommost support pixel y55 (support bottom edge y56); no silhouette height normalization.',
    palette: 'concept-palette-24.json', methods: {
      nearest: 'Cell-center nearest source sample; binary foreground mask.',
      area: 'Exact source-pixel area-weighted mean RGB among foreground; at least 50 percent foreground coverage required.',
      'dominant-24': 'Same area/coverage rule; most-covered common-palette cluster wins instead of mean RGB.',
      'nearest-24': 'Cell-center nearest sample mapped to nearest of 24 actual source-color medoids.' },
    rawConceptCrops: rawCrops, comparisons: records, selectedConstructionCells: selected,
    selectionNotes: 'Down/right/left use source-aligned nearest-24 phases to sample the original black pupil clusters and white sclera on two consecutive rows. Back uses dominant source-palette coverage to preserve narrow outlines without area blur. No anatomy redrawn.',
    eyeSourceEvidence: { region: 'Original down-facing concept; rows y359 through y367', leftPupilX: [304, 308], rightPupilX: [334, 338],
      selectedSamplePupils: [[306, 359], [306, 367], [335, 359], [335, 367]], selectedWhiteNeighbors: [[298, 359], [342, 359]],
      rightProfile: { pupilX: [713, 717], pupilY: [358, 367], selectedSamples: [[715, 358], [715, 366]] },
      leftProfile: { pupilX: [1046, 1049], pupilY: [358, 367], selectedSamples: [[1047, 359], [1047, 367]] },
      scope: 'Source-pixel alignment evidence, not automatic visual approval.' },
    review: { file: 'concept-sampling-comparison.png', sha256: hash(board) } }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ scale, figures, selected }, null, 2) + '\n');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
