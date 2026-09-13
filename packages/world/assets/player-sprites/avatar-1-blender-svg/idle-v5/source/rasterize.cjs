#!/usr/bin/env node
'use strict';

/**
 * Run with the bundled Node executable; no working-directory assumption.
 * Inputs: source/palette.json and svg/{down,left,right,up}/idle.svg.
 * SVGs must already occupy the authored 512x512 coordinate system. This export
 * never fits individual silhouettes or changes their height. Transparent edge
 * coverage and sRGB colors remain smooth. All directions use one common
 * 512-to-256 downsample, without palette remapping or alpha thresholding.
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
const CELL = 512;
const PNG_SIZE = 256;
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
  check(bytes.length <= 32 * 1024 * 1024, `${label}: SVG exceeds 32 MiB`);
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
        `${label}: SVG viewport must already be 512x512`);
      const viewBox = (attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
      check(viewBox.length === 4 && viewBox.every((value, i) => value === [0, 0, CELL, CELL][i]),
        `${label}: viewBox must already be 0 0 512 512`);
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

function measure(raw, label) {
  let minX = PNG_SIZE, minY = PNG_SIZE, maxX = -1, maxY = -1;
  let coveredPixels = 0, partialAlphaPixels = 0;
  const colors = new Set();
  for (let y = 0; y < PNG_SIZE; y++) for (let x = 0; x < PNG_SIZE; x++) {
    const index = (y * PNG_SIZE + x) * 4;
    const alpha = raw[index + 3];
    if (!alpha) continue;
    check(x > 0 && y > 0 && x < PNG_SIZE - 1 && y < PNG_SIZE - 1,
      `${label}: covered art touches the cell boundary; fix vector framing`);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    coveredPixels++;
    if (alpha < 255) partialAlphaPixels++;
    colors.add(raw.subarray(index, index + 4).toString('hex'));
  }
  check(coveredPixels > 0, `${label}: vector export rasterizes to an empty sprite`);
  return { dimensions: [PNG_SIZE, PNG_SIZE], coveredPixels, partialAlphaPixels,
    transparentPixels: PNG_SIZE * PNG_SIZE - coveredPixels,
    boundsInclusive: [minX, minY, maxX, maxY], rgbaColorCount: colors.size,
    boundaryCoveredPixels: 0 };
}

async function makeBoard(frames) {
  const columnWidth = 300, gap = 24, margin = 32;
  const width = margin * 2 + frames.length * columnWidth + (frames.length - 1) * gap;
  const height = 668;
  const panels = [];
  let markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#F5F2E9"/>
    <text x="32" y="40" font-family="Arial,sans-serif" font-size="23" font-weight="700" fill="#203B35">Avatar 1 · detailed vector idle inspection</text>
    <text x="32" y="70" font-family="Arial,sans-serif" font-size="14" fill="#54685D">512² native vector source → 256² texture · 64 × 64 logical cell</text>
    <text x="32" y="635" font-family="Arial,sans-serif" font-size="13" fill="#54685D">INTERNAL REFINEMENT. Export inspection only; live game review and artistic acceptance are separate.</text>`;
  frames.forEach((frame, index) => {
    const left = margin + index * (columnWidth + gap);
    markup += `<text x="${left + columnWidth/2}" y="105" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="#203B35">${frame.direction.toUpperCase()}</text>
      <rect x="${left}" y="120" width="300" height="300" fill="#E3E0D6"/>
      <text x="${left + 150}" y="445" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" fill="#54685D">256 px texture · 4× logical size</text>
      <rect x="${left}" y="461" width="300" height="142" rx="8" fill="#27433B"/>
      <text x="${left + 64}" y="593" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#E2E9DF">64 px</text>
      <text x="${left + 204}" y="593" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#E2E9DF">128 px · 2× camera</text>`;
    panels.push({direction:frame.direction, left:left+22, top:142, size:256},
      {direction:frame.direction,left:left+32,top:490,size:64},
      {direction:frame.direction,left:left+140,top:463,size:128});
  });
  markup += '</svg>';
  const overlays = [];
  for (const panel of panels) {
    const frame = frames.find(frame => frame.direction === panel.direction);
    overlays.push({left:panel.left,top:panel.top,input:await sharp(frame.png)
      .resize(panel.size,panel.size,{kernel:'lanczos3'}).png().toBuffer()});
  }
  const bytes = await sharp(Buffer.from(markup)).composite(overlays).png().toBuffer();
  return {bytes,dimensions:[width,height],panels};
}

async function main() {
  check(process.argv.length === 2, 'Usage: node source/rasterize.cjs');
  const {execFileSync} = require('node:child_process');
  // Reuse the authoritative geometry/concept/study hash contract without duplicating it.
  const contract = JSON.parse(execFileSync('python3', ['-c',
    'import json,sys; sys.path.insert(0,sys.argv[1]); import source_contract as c; d=c.load(sys.argv[1]); print(json.dumps({"directions":d["directions"],"geometrySha256":d["geometrySha256"],"paletteSha256":d["paletteSha256"],"conceptSha256":d["approval"]["sha256"]}))',
    __dirname], {encoding:'utf8'}));
  const environment = JSON.parse(await fs.readFile(path.join(__dirname,'blender-environment.json'),'utf8'));
  check(environment.geometrySha256 === contract.geometrySha256 &&
    environment.paletteSha256 === contract.paletteSha256 &&
    environment.conceptSha256 === contract.conceptSha256 && environment.nativeMcpTools === true,
    'Native export inputs are stale or lack explicit native-MCP provenance');
  check(environment.masterSha256 === sha256(await fs.readFile(path.join(__dirname,'avatar-1.blend'))),
    'Saved Blender master differs from native export environment');
  check(JSON.stringify(environment.directions) === JSON.stringify(contract.directions),
    'Native export direction inventory differs from current declared geometry');
  const frames = [];
  for (const direction of contract.directions) {
    const sourcePath = path.join(ROOT,'svg',direction,'idle.svg');
    const source = await fs.readFile(sourcePath);
    const exported = environment.exports.find(entry => entry.direction === direction);
    check(exported && exported.sha256 === sha256(source), `${direction}: native SVG export hash is stale`);
    const inspected = inspectSvg(source,direction);
    const output = await sharp(inspected.canonical,{density:72,limitInputPixels:CELL*CELL})
      .toColourspace('srgb').ensureAlpha().resize(PNG_SIZE,PNG_SIZE,{kernel:'lanczos3'})
      .png({compressionLevel:9,palette:false}).toBuffer();
    const rendered = await sharp(output).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    check(rendered.info.width === PNG_SIZE && rendered.info.height === PNG_SIZE && rendered.info.channels === 4,
      `${direction}: raster texture size changed`);
    const metrics = measure(rendered.data,direction);
    frames.push({direction,png:output,report:{
      svg:relative(sourcePath),svgSha256:sha256(source),renderedSvgSha256:sha256(inspected.canonical),
      pathCount:inspected.pathCount,standardDoctypeStripped:inspected.declaredDoctypeRemoved,
      frame:`frames/${direction}/idle.png`,pngSha256:sha256(output),rgbaSha256:sha256(rendered.data),
      ...metrics}});
  }
  const board = await makeBoard(frames);
  const report = {schemaVersion:1,revision:'idle-v5',directions:contract.directions,
    mechanicalStatus:'pass',artisticQuality:'not-assessed',userIdleApproval:'not-granted',
    animationAcceptance:'not-tested',liveGameAcceptance:'not-tested',
    registration:{sourceCell:[512,512],sourceFeet:[256,448],textureCell:[256,256],textureFeet:[128,224],
      logicalCell:[64,64],logicalFeet:[32,56],density:4},
    treatment:{rasterizer:'Sharp/libvips SVG rasterization at 512x512, Lanczos3 downsample to 256x256',
      alpha:'preserved smooth coverage; no binary-alpha threshold',
      color:'preserved sRGB fills and antialias blends; no palette remapping or output color cap',
      framing:'fixed common canvas; no direction-specific trim, fit, rotation, or scale',
      preview:'Exact exported textures, resampled to stated widths; static export preview is not live game evidence'},
    runtime:{node:process.version,platform:process.platform,arch:process.arch,sharp:sharp.versions},
    source:{script:'source/rasterize.cjs',scriptSha256:sha256(await fs.readFile(__filename)),...contract},
    frames:frames.map(frame=>frame.report),
    review:{file:'review/idle-inspection.png',pngSha256:sha256(board.bytes),dimensions:board.dimensions,panels:board.panels}};
  for (const frame of frames) {
    const destination=path.join(ROOT,frame.report.frame);
    await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,frame.png);
  }
  await fs.mkdir(path.join(ROOT,'review'),{recursive:true});
  await fs.writeFile(path.join(ROOT,'review/idle-inspection.png'),board.bytes);
  await fs.writeFile(path.join(ROOT,'review/raster-qa.json'),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(`Rasterized ${frames.length} detailed vector idle(s) to 256² textures; alpha and color detail preserved.\n`+
    'Technical raster checks do not establish visual quality or live-game acceptance.\n');
}
main().catch(error=>{process.stderr.write(`Rasterization failed: ${error.message}\n`);process.exitCode=1;});
