// Export the generated idle reference once; no drawing or per-pixel repair.
const sharp = require('sharp');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const names = ['down', 'left', 'right', 'up'];
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const rgba = (data, width, height) => sharp(data, { raw: { width, height, channels: 4 } });

function bounds(data, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] < 128) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (x1 < x0) throw Error('Empty source view');
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

async function main() {
  const source = await fs.readFile(path.join(__dirname, 'generated-turnaround.png'));
  const meta = await sharp(source).metadata();
  const half = meta.width / 2;
  if (!Number.isInteger(half) || meta.width !== meta.height) throw Error('Expected even square 2x2 source');
  const cells = [], records = [];
  for (let n = 0; n < names.length; n++) {
    const region = { left: (n % 2) * half, top: Math.floor(n / 2) * half, width: half, height: half };
    const crop = await sharp(source).extract(region).ensureAlpha().raw().toBuffer();
    const box = bounds(crop, half, half);
    const scaled = await rgba(crop, half, half).extract(box).resize({ height: 50, kernel: 'nearest' }).raw().toBuffer({ resolveWithObject: true });
    const w = scaled.info.width;
    if (w > 54) throw Error('Draft too wide for safe margins');
    const cell = Buffer.alloc(64 * 64 * 4);
    const soleXs = [];
    for (let y = 48; y < 50; y++) for (let x = 0; x < w; x++) if (scaled.data[(y*w+x)*4+3] >= 128) soleXs.push(x);
    const soleCentre = (Math.min(...soleXs) + Math.max(...soleXs)) / 2;
    const xStart = 32 - Math.round(soleCentre);
    for (let y = 0; y < 50; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, j = ((y + 7) * 64 + x + xStart) * 4;
      if (scaled.data[i + 3] < 128) continue;
      cell[j] = scaled.data[i]; cell[j + 1] = scaled.data[i + 1]; cell[j + 2] = scaled.data[i + 2]; cell[j + 3] = 255;
    }
    cells.push(cell);
    records.push({ direction: names[n], sourceRegion: region, sourceOpaqueBounds: box, scaledWidth: w, soleCentreX: xStart + soleCentre });
  }
  // Deterministic shared 24-colour export. Reserve dark facial/outline and
  // light facial colours; choose remaining centres from source samples.
  const histogram = new Map();
  for (const cell of cells) for (let i=0;i<cell.length;i+=4) if (cell[i+3]) {
    const key=cell.subarray(i,i+3).toString('hex');
    histogram.set(key, (histogram.get(key)||0)+1);
  }
  const samples=[...histogram].sort((a,b)=>a[0].localeCompare(b[0])).map(([hex,n])=>({rgb:[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)),n}));
  const distance=(a,b)=>a.reduce((s,v,i)=>s+(v-b[i])**2,0);
  const centres=[[27,23,23],[247,223,193]];
  while(centres.length<24) {
    let best=samples[0], score=-1;
    for(const p of samples) { const s=Math.min(...centres.map(c=>distance(p.rgb,c)))*Math.sqrt(p.n); if(s>score){score=s;best=p;} }
    centres.push([...best.rgb]);
  }
  const nearest=rgb=>centres.reduce((best,c,i)=>distance(rgb,c)<distance(rgb,centres[best])?i:best,0);
  for(let iteration=0;iteration<24;iteration++) {
    const sums=centres.map(()=>[0,0,0,0]);
    for(const p of samples){const k=nearest(p.rgb);for(let i=0;i<3;i++)sums[k][i]+=p.rgb[i]*p.n;sums[k][3]+=p.n;}
    for(let k=2;k<24;k++)if(sums[k][3])centres[k]=sums[k].slice(0,3).map(v=>Math.round(v/sums[k][3]));
  }
  for(const cell of cells)for(let i=0;i<cell.length;i+=4)if(cell[i+3]){
    const colour=centres[nearest([...cell.subarray(i,i+3)])];for(let j=0;j<3;j++)cell[i+j]=colour[j];
  }
  const merged = await sharp({ create: { width: 256, height: 64, channels: 4, background: '#00000000' } }).composite(cells.map((cell, n) => ({ input: cell, raw: { width: 64, height: 64, channels: 4 }, left: n * 64, top: 0 }))).png().toBuffer();
  await fs.writeFile(path.join(root, 'avatar-1-idle-turnaround.png'), merged);
  const palette = new Set();
  const outCells = [];
  for (let n = 0; n < names.length; n++) {
    const png = await sharp(merged).extract({ left: n * 64, top: 0, width: 64, height: 64 }).png().toBuffer();
    const raw = await sharp(png).ensureAlpha().raw().toBuffer();
    const b = bounds(raw, 64, 64);
    const alphas = new Set(), colours = new Set();
    for (let i = 0; i < raw.length; i += 4) {
      alphas.add(raw[i + 3]);
      if (raw[i + 3]) { const c = raw.subarray(i, i + 3).toString('hex'); colours.add(c); palette.add(c); }
    }
    const connected = new Set(); let components = 0;
    for (let p = 0; p < 4096; p++) {
      if (!raw[p * 4 + 3] || connected.has(p)) continue;
      components++; const queue = [p]; connected.add(p);
      for (let k = 0; k < queue.length; k++) {
        const q = queue[k], x = q % 64, y = Math.floor(q / 64);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, t = ny * 64 + nx;
          if (nx < 0 || nx > 63 || ny < 0 || ny > 63 || connected.has(t) || !raw[t * 4 + 3]) continue;
          connected.add(t); queue.push(t);
        }
      }
    }
    const clipped = b.left === 0 || b.top === 0 || b.left + b.width === 64 || b.top + b.height === 64;
    const pass = alphas.size === 2 && alphas.has(0) && alphas.has(255) && b.top + b.height - 1 === 56 && !clipped && colours.size <= 24;
    if (!pass) throw Error('Export geometry/alpha failed: ' + names[n]);
    Object.assign(records[n], { dimensions: [64, 64], opaqueBounds: b, opaqueColours: colours.size, alphaValues: [...alphas].sort((a,b) => a-b), connectedComponents8: components, clipped, pngSha256: digest(png), rgbaSha256: digest(raw), mechanicalExport: 'pass' });
    await fs.writeFile(path.join(root, 'cells', names[n] + '-idle.png'), png);
    outCells.push(png);
  }
  const width = 1120, height = 640;
  const text = `<svg width="${width}" height="${height}"><style>text{font-family:Arial,sans-serif;fill:#e8e9eb}</style><text x="32" y="43" font-size="25" font-weight="bold">Avatar 1 · Teal Scarf Runner</text><text x="32" y="72" font-size="15" fill="#aeb8bd">Fresh idle draft · exact 64×64 cells · awaiting your approval</text>${names.map((n,i)=>`<text x="${160+i*264}" y="112" text-anchor="middle" font-size="14">${n.toUpperCase()}</text>`).join('')}<text x="32" y="400" font-size="14">Above: 4× pixel view     Below: 2× game-scale preview</text><text x="32" y="612" font-size="14">Same exported pixels in both views · no animation or game integration yet</text></svg>`;
  const reviewLayers = [{ input: Buffer.from(text), left: 0, top: 0 }];
  for (let i = 0; i < 4; i++) {
    reviewLayers.push({ input: await sharp(outCells[i]).resize(256, 256, { kernel: 'nearest' }).png().toBuffer(), left: 32 + i * 264, top: 122 });
    reviewLayers.push({ input: await sharp(outCells[i]).resize(128, 128, { kernel: 'nearest' }).flatten({ background: '#dce1d5' }).png().toBuffer(), left: 96 + i * 264, top: 430 });
  }
  await sharp({ create: { width, height, channels: 4, background: '#293237' } }).composite(reviewLayers).png().toFile(path.join(root, 'review', 'approval.png'));
  if(palette.size>24)throw Error('Shared palette exceeded 24 colours');
  const report = { status: 'draft-awaiting-user-approval', created: '2026-09-12', sourceSha256: digest(source), exportTool: `sharp ${sharp.versions.sharp} / libvips ${sharp.versions.vips}`, grid: [64,64], feetPivot: [32,56], visibleHeight: 50, facingOrder: names, export: 'Per-view alpha bounds; nearest resize to 50px height; sole registration; alpha threshold 128; shared 24-colour quantization with two reserved facial/outline colours; no pixel repairs.', opaquePalette: [...palette].sort(), sheetSha256: digest(merged), cells: records, mechanicalScope: 'dimensions, binary alpha, feet line, safe bounds, palette count, component count, PNG/RGBA hashes', visualApproval: 'pending-user', animation: 'not-started', runtimeIntegration: 'not-performed' };
  await fs.writeFile(path.join(root, 'review', 'qa.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ paletteColours: palette.size, cells: records.map(r=>({direction:r.direction,bounds:r.opaqueBounds,components:r.connectedComponents8,status:r.mechanicalExport})), review: path.join(root,'review','approval.png') },null,2));
}
main().catch(e=>{ console.error(e); process.exitCode=1; });
