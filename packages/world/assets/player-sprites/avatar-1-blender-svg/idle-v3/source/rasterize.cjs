#!/usr/bin/env node
'use strict';

/**
 * Run with the bundled Node executable; no working-directory assumption.
 * Inputs: source/palette.json and svg/{down,left,right,up}/idle.svg.
 * SVGs must already occupy the authored 64x64 coordinate system. This export
 * never fits individual silhouettes or changes their height. Transparent edge
 * coverage is thresholded at 128; visible RGB is mapped to the nearest authored
 * palette entry by squared Euclidean sRGB distance, with palette-order ties.
 * This produces review evidence, never user approval or game acceptance.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const modules = process.env.STRKWORLD_NODE_MODULES ||
  '/Users/james.wilcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const sharp = require(path.join(modules, 'sharp'));
const sax = require(path.join(modules, 'sax'));

const ROOT = path.resolve(__dirname, '..');
const DIRECTIONS = ['down', 'left', 'right', 'up'];
const CELL = 64;
const ALPHA_THRESHOLD = 128;
const TAGS = new Set(['svg', 'g', 'defs', 'clipPath', 'path', 'rect', 'polygon',
  'polyline', 'circle', 'ellipse', 'title', 'desc']);
const ATTRIBUTES = new Set(['version', 'x', 'y', 'xmlns', 'width', 'height',
  'viewBox', 'id', 'clip-path', 'd', 'points', 'fill', 'stroke', 'fill-rule',
  'fill-opacity', 'stroke-opacity', 'opacity', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'cx', 'cy', 'r', 'rx', 'ry']);
const STANDARD_DTD = /^svg\s+PUBLIC\s+"-\/\/W3C\/\/DTD SVG 1\.1\/\/EN"\s+"http:\/\/www\.w3\.org\/Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd"$/;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const escapeXml = (value) => String(value).replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const relative = (filename) => path.relative(ROOT, filename).split(path.sep).join('/');
const rgb = (hex) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));

function numeric(value, label) {
  check(typeof value === 'string' && /^[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?(?:px)?$/i.test(value),
    `${label}: expected a finite SVG number`);
  const number = Number(value.replace(/px$/, ''));
  check(Number.isFinite(number), `${label}: nonfinite coordinate`);
  return number;
}

function checkCoordinates(attributes, tag, label) {
  const point = (x, y) => {
    check(x >= -0.0001 && y >= -0.0001 && x <= CELL + 0.0001 && y <= CELL + 0.0001,
      `${label}: off-canvas ${tag} coordinate (${x}, ${y}); fix the SVG source framing`);
  };
  if (tag === 'path') {
    const data = attributes.d || '';
    // Native Grease Pencil export uses absolute M/L paths. Absolute quadratic
    // and cubic control points are also accepted with conservative bounds.
    const tokens = data.match(/[a-zA-Z]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/g) || [];
    check(data.replace(/[a-zA-Z]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/g, '')
      .replace(/[\s,]/g, '') === '', `${label}: unsupported path syntax`);
    check(tokens.length > 0, `${label}: empty path`);
    let index = 0;
    while (index < tokens.length) {
      const command = tokens[index++];
      check(['M', 'L', 'C', 'Q', 'Z', 'z'].includes(command),
        `${label}: unsupported path command ${command}; export absolute Grease Pencil paths`);
      if (command === 'Z' || command === 'z') continue;
      const start = index;
      while (index < tokens.length && !/^[a-zA-Z]$/.test(tokens[index])) index++;
      const values = tokens.slice(start, index).map(Number);
      const stride = command === 'C' ? 6 : command === 'Q' ? 4 : 2;
      check(values.length > 0 && values.length % stride === 0 && values.every(Number.isFinite),
        `${label}: malformed ${command} path coordinates`);
      for (let i = 0; i < values.length; i += 2) point(values[i], values[i + 1]);
    }
  } else if (tag === 'rect') {
    const x = numeric(attributes.x || '0', label), y = numeric(attributes.y || '0', label);
    const width = numeric(attributes.width, label), height = numeric(attributes.height, label);
    check(width >= 0 && height >= 0, `${label}: negative rectangle dimensions`);
    point(x, y); point(x + width, y + height);
  } else if (tag === 'circle' || tag === 'ellipse') {
    const x = numeric(attributes.cx || '0', label), y = numeric(attributes.cy || '0', label);
    const rx = numeric(tag === 'circle' ? attributes.r : attributes.rx, label);
    const ry = numeric(tag === 'circle' ? attributes.r : attributes.ry, label);
    check(rx >= 0 && ry >= 0, `${label}: negative radius`);
    point(x - rx, y - ry); point(x + rx, y + ry);
  } else if (tag === 'polygon' || tag === 'polyline') {
    const values = (attributes.points || '').trim().split(/[\s,]+/).map(Number);
    check(values.length >= 4 && values.length % 2 === 0 && values.every(Number.isFinite),
      `${label}: malformed point list`);
    for (let i = 0; i < values.length; i += 2) point(values[i], values[i + 1]);
  }
}

function inspectSvg(bytes, label) {
  check(bytes.length <= 8 * 1024 * 1024, `${label}: SVG exceeds 8 MiB`);
  const source = bytes.toString('utf8');
  check(!/<!ENTITY/i.test(source), `${label}: entity declarations are forbidden`);
  const parser = sax.parser(true, { trim: false });
  const tree = [], stack = [], clipReferences = [], ids = new Set();
  let pathCount = 0, declaredDoctypeRemoved = false;
  parser.ondoctype = (declaration) => {
    check(STANDARD_DTD.test(declaration.trim()), `${label}: nonstandard/external DOCTYPE`);
    declaredDoctypeRemoved = true;
  };
  parser.onprocessinginstruction = (instruction) => {
    check(instruction.name.toLowerCase() === 'xml', `${label}: processing instructions forbidden`);
  };
  parser.onopentag = (node) => {
    check(TAGS.has(node.name), `${label}: forbidden SVG element <${node.name}>`);
    const attrs = node.attributes;
    for (const [name, value] of Object.entries(attrs)) {
      check(ATTRIBUTES.has(name), `${label}: unsupported or external attribute ${name}`);
      check(!/url\s*\(/i.test(value) || name === 'clip-path', `${label}: external paint reference`);
      if (name === 'clip-path') {
        check(/^url\(#[A-Za-z_][\w.:-]*\)$/.test(value), `${label}: clip reference must be local`);
        clipReferences.push(value.slice(5, -1));
      }
      if (name === 'fill' || name === 'stroke') {
        check(/^(none|#[0-9a-f]{3}|#[0-9a-f]{6})$/i.test(value), `${label}: only flat hex fills/strokes allowed`);
      }
      if (name === 'id') {
        check(!ids.has(value), `${label}: duplicate SVG id ${value}`); ids.add(value);
      }
    }
    if (node.name === 'svg') {
      check(stack.length === 0 && tree.length === 0, `${label}: exactly one root SVG required`);
      check(attrs.xmlns === 'http://www.w3.org/2000/svg', `${label}: wrong SVG namespace`);
      check(numeric(attrs.width, label) === CELL && numeric(attrs.height, label) === CELL,
        `${label}: SVG viewport must already be 64x64`);
      const viewBox = (attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
      check(viewBox.length === 4 && viewBox.every((value, i) => value === [0, 0, CELL, CELL][i]),
        `${label}: viewBox must already be 0 0 64 64`);
      check(numeric(attrs.x || '0', label) === 0 && numeric(attrs.y || '0', label) === 0,
        `${label}: root viewport must not be offset`);
    } else check(stack.length > 0, `${label}: content outside SVG root`);
    checkCoordinates(attrs, node.name, label);
    if (node.name === 'path') pathCount++;
    const element = { tag: node.name, attributes: attrs, children: [] };
    (stack.length ? stack[stack.length - 1].children : tree).push(element);
    stack.push(element);
  };
  parser.onclosetag = () => stack.pop();
  parser.ontext = (text) => {
    if (!text.trim()) return;
    check(stack.length && ['title', 'desc'].includes(stack[stack.length - 1].tag),
      `${label}: text artwork/fonts are forbidden`);
    stack[stack.length - 1].children.push(text);
  };
  parser.oncdata = () => { throw new Error(`${label}: CDATA is forbidden`); };
  parser.write(source).close();
  check(tree.length === 1 && pathCount > 0, `${label}: a nonempty path-based SVG is required`);
  for (const id of clipReferences) check(ids.has(id), `${label}: missing clip target ${id}`);
  const serialize = (node) => typeof node === 'string' ? escapeXml(node) :
    `<${node.tag}${Object.entries(node.attributes).map(([name, value]) =>
      ` ${name}="${escapeXml(value)}"`).join('')}>${node.children.map(serialize).join('')}</${node.tag}>`;
  return { canonical: Buffer.from(serialize(tree[0])), pathCount, declaredDoctypeRemoved };
}

function quantize(raw, palette) {
  const output = Buffer.alloc(raw.length);
  let partialAlphaPixels = 0, discardedCoveredPixels = 0, remappedPixels = 0;
  let sumSquaredDistance = 0, maximumSquaredDistance = 0, opaquePixels = 0;
  for (let offset = 0; offset < raw.length; offset += 4) {
    const alpha = raw[offset + 3];
    if (alpha > 0 && alpha < 255) partialAlphaPixels++;
    if (alpha < ALPHA_THRESHOLD) { if (alpha > 0) discardedCoveredPixels++; continue; }
    let selected = palette[0], distance = Infinity;
    for (const entry of palette) {
      const candidate = entry.rgb.reduce((total, value, channel) => total + (raw[offset + channel] - value) ** 2, 0);
      if (candidate < distance) { selected = entry; distance = candidate; }
    }
    for (let channel = 0; channel < 3; channel++) output[offset + channel] = selected.rgb[channel];
    output[offset + 3] = 255;
    opaquePixels++;
    if (distance > 0) remappedPixels++;
    sumSquaredDistance += distance;
    maximumSquaredDistance = Math.max(maximumSquaredDistance, distance);
  }
  return { output, treatment: { partialAlphaPixels, discardedCoveredPixels, remappedPixels,
    maximumSquaredDistance, meanSquaredDistance: opaquePixels ? sumSquaredDistance / opaquePixels : 0 } };
}

function measure(raw, label) {
  let minX = CELL, minY = CELL, maxX = -1, maxY = -1, opaquePixels = 0;
  const colors = new Map();
  const rowCounts = Array(CELL).fill(0);
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const index = (y * CELL + x) * 4;
    check(raw[index + 3] === 0 || raw[index + 3] === 255, `${label}: alpha must be binary`);
    if (!raw[index + 3]) continue;
    check(x > 0 && y > 0 && x < CELL - 1 && y < CELL - 1,
      `${label}: opaque art touches the cell boundary; check source framing/clipping`);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    opaquePixels++; rowCounts[y]++;
    const hex = `#${raw.subarray(index, index + 3).toString('hex').toUpperCase()}`;
    colors.set(hex, (colors.get(hex) || 0) + 1);
  }
  check(opaquePixels > 0, `${label}: SVG rasterizes to an empty sprite`);
  return { dimensions: [CELL, CELL], opaquePixels, transparentPixels: CELL * CELL - opaquePixels,
    partialAlphaPixels: 0, boundsInclusive: [minX, minY, maxX, maxY],
    visibleSize: [maxX - minX + 1, maxY - minY + 1], colorCount: colors.size,
    colors: [...colors].sort(([a], [b]) => a.localeCompare(b)).map(([hex, count]) => ({ hex, pixels: count })),
    rowOpaqueCounts: rowCounts, boundaryOpaquePixels: 0 };
}

async function png(raw, width = CELL, height = CELL) {
  return sharp(raw, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, palette: false }).toBuffer();
}

async function makeBoard(frames) {
  const width = 1688, height = 850, margin = 40, gap = 24, columnWidth = 384;
  const enlargedBackground = '#E8E4DA', smallBackground = '#223932';
  let markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#F8F6F0"/>
    <text x="40" y="58" font-family="Arial,sans-serif" font-size="32" font-weight="700" fill="#183B33">Avatar 1 · four idle views</text>
    <text x="40" y="91" font-family="Arial,sans-serif" font-size="18" fill="#596A62">Exact SVG-derived 64 × 64 cells · fixed framing · nearest-neighbour previews</text>
    <text x="40" y="816" font-family="Arial,sans-serif" font-size="16" fill="#596A62">DRAFT FOR APPROVAL — identity, proportions and silhouette. Animation and in-game acceptance are pending.</text>`;
  const placements = [];
  for (let i = 0; i < frames.length; i++) {
    const left = margin + i * (columnWidth + gap), center = left + columnWidth / 2;
    markup += `<text x="${center}" y="140" text-anchor="middle" font-family="Arial,sans-serif" font-size="19" font-weight="700" fill="#183B33">${DIRECTIONS[i].toUpperCase()}</text>
      <rect x="${left}" y="162" width="384" height="384" fill="${enlargedBackground}"/>
      <text x="${center}" y="573" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" fill="#596A62">6× · inspect the pixel shapes</text>
      <rect x="${left}" y="597" width="384" height="164" rx="8" fill="${smallBackground}"/>
      <text x="${left + 92}" y="785" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" fill="#596A62">1× · native cell</text>
      <text x="${left + 268}" y="785" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" fill="#596A62">2× · game scale</text>`;
    placements.push({ direction: DIRECTIONS[i], scale: 6, left, top: 162, background: enlargedBackground },
      { direction: DIRECTIONS[i], scale: 1, left: left + 60, top: 647, background: smallBackground },
      { direction: DIRECTIONS[i], scale: 2, left: left + 204, top: 615, background: smallBackground });
  }
  markup += '</svg>';
  const overlays = [];
  for (const placement of placements) {
    const frame = frames.find((candidate) => candidate.direction === placement.direction);
    const size = CELL * placement.scale;
    overlays.push({ input: await sharp(frame.png).resize(size, size, { kernel: 'nearest' }).png().toBuffer(),
      left: placement.left, top: placement.top });
  }
  const board = await sharp(Buffer.from(markup)).composite(overlays).png({ compressionLevel: 9, palette: false }).toBuffer();
  const boardRaw = await sharp(board).ensureAlpha().raw().toBuffer();
  for (const placement of placements) {
    const frame = frames.find((candidate) => candidate.direction === placement.direction);
    const background = rgb(placement.background);
    for (let y = 0; y < CELL * placement.scale; y++) for (let x = 0; x < CELL * placement.scale; x++) {
      const source = (Math.floor(y / placement.scale) * CELL + Math.floor(x / placement.scale)) * 4;
      const target = ((placement.top + y) * width + placement.left + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const expected = frame.raw[source + 3] ? frame.raw[source + channel] : background[channel];
        check(boardRaw[target + channel] === expected, `Review crop parity failed: ${placement.direction} ${placement.scale}x`);
      }
      check(boardRaw[target + 3] === 255, 'Review board must be opaque');
    }
  }
  return { board, dimensions: [width, height], placements };
}

async function main() {
  check(process.argv.length === 2, 'Usage: node source/rasterize.cjs');
  const concept = JSON.parse(await fs.readFile(path.join(ROOT, '../concept/approval.json'), 'utf8'));
  check(concept.status === 'approved', 'Fresh concept approval is required before sprite export');
  check(sha256(await fs.readFile(path.join(ROOT, '../concept', concept.artifact))) === concept.sha256, 'Approved concept changed');
  const decision = JSON.parse(await fs.readFile(path.join(ROOT, 'review/user-decisions.json'), 'utf8'));
  check(decision.status === 'pending',
    'This generator only updates a pending draft. Preserve a rejected or approved review and explicitly start a new revision before changing its pixels.');
  const palettePath = path.join(__dirname, 'palette.json');
  const paletteBytes = await fs.readFile(palettePath);
  const paletteDocument = JSON.parse(paletteBytes);
  check(Array.isArray(paletteDocument.colors) && paletteDocument.colors.length > 0,
    'palette.json requires colors: [{name, hex}]');
  const limit = paletteDocument.maximumColorsPerFrame ?? 24;
  check(Number.isInteger(limit) && limit > 0 && limit <= 256, 'Invalid maximumColorsPerFrame');
  const seen = new Set();
  const palette = paletteDocument.colors.map((entry) => {
    check(entry && typeof entry.name === 'string' && entry.name.length > 0 && /^#[0-9a-f]{6}$/i.test(entry.hex),
      'Every palette color requires a name and #RRGGBB hex');
    const hex = entry.hex.toUpperCase();
    check(!seen.has(hex), `Duplicate palette color ${hex}`); seen.add(hex);
    return { name: entry.name, hex, rgb: rgb(hex) };
  });
  check(palette.length <= limit, `Authored palette exceeds declared ${limit}-color limit`);
  const frames = [];
  // Validate/rasterize all inputs before writing any deliverable.
  for (const direction of DIRECTIONS) {
    const sourcePath = path.join(ROOT, 'svg', direction, 'idle.svg');
    const source = await fs.readFile(sourcePath);
    const inspected = inspectSvg(source, direction);
    const rendered = await sharp(inspected.canonical, { density: 72, limitInputPixels: CELL * CELL })
      .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    check(rendered.info.width === CELL && rendered.info.height === CELL && rendered.info.channels === 4,
      `${direction}: renderer changed the authored 64x64 viewport`);
    const quantized = quantize(rendered.data, palette);
    const metrics = measure(quantized.output, direction);
    check(metrics.colorCount <= limit, `${direction}: palette limit exceeded`);
    const output = await png(quantized.output);
    frames.push({ direction, raw: quantized.output, png: output, report: {
      svg: relative(sourcePath), svgSha256: sha256(source), renderedSvgSha256: sha256(inspected.canonical),
      pathCount: inspected.pathCount, standardDoctypeStripped: inspected.declaredDoctypeRemoved,
      frame: `frames/${direction}/idle.png`, pngSha256: sha256(output), rgbaSha256: sha256(quantized.output),
      rasterTreatment: quantized.treatment, ...metrics } });
  }
  const board = await makeBoard(frames);
  const report = {
    schemaVersion: 1, avatar: 'avatar-1', pose: 'idle', directions: DIRECTIONS,
    mechanicalStatus: 'pass', userIdleApproval: 'pending', animationAcceptance: 'not-tested',
    liveGameAcceptance: 'not-tested',
    treatment: { rasterizer: 'Sharp/libvips SVG rasterization at 72 DPI in the authored 64x64 viewport',
      perViewRescaling: false, alpha: `coverage >= ${ALPHA_THRESHOLD} becomes 255; lower coverage becomes 0 with RGB zeroed`,
      color: 'nearest authored RGB by squared Euclidean sRGB distance; first palette entry wins ties',
      previews: 'integer nearest-neighbour scaling of the final PNG pixels',
      geometry: 'flat self-contained vectors; absolute path coordinates/control points inside [0,64]; no transforms, raster images, external resources or filters',
      approval: 'mechanical conformance only; aesthetic approval and runtime acceptance remain separate' },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, sharp: sharp.versions },
    source: { script: 'source/rasterize.cjs', scriptSha256: sha256(await fs.readFile(__filename)),
      palette: 'source/palette.json', paletteSha256: sha256(paletteBytes), maximumColorsPerFrame: limit,
      authoredColors: palette.map(({ name, hex }) => ({ name, hex })) },
    frames: frames.map((frame) => frame.report),
    review: { file: 'review/idle-approval.png', dimensions: board.dimensions,
      pngSha256: sha256(board.board), exactCompositeCropParity: true, placements: board.placements },
  };
  for (const frame of frames) {
    const destination = path.join(ROOT, frame.report.frame);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, frame.png);
  }
  await fs.mkdir(path.join(ROOT, 'review'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'review', 'idle-approval.png'), board.board);
  await fs.writeFile(path.join(ROOT, 'review', 'qa.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Rasterized four 64x64 idles; exact 1x/2x/6x review crop parity passed.\n${path.join(ROOT, 'review', 'idle-approval.png')}\nUser approval and in-game acceptance remain pending.\n`);
}

main().catch((error) => { process.stderr.write(`Rasterization failed: ${error.message}\n`); process.exitCode = 1; });
