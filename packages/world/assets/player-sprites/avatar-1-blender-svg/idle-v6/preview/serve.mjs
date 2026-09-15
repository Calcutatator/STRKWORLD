import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const previewRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(previewRoot, '../../../../../../..');
const dependencyRoot = process.env.STRKWORLD_PREVIEW_DEPS || [
  resolve(repositoryRoot, 'node_modules'),
  resolve(repositoryRoot, '../STRKWORLD/node_modules'),
].find((candidate) => existsSync(resolve(candidate, 'vite/dist/node/index.js')));
if (!dependencyRoot) throw new Error('Set STRKWORLD_PREVIEW_DEPS to the installed node_modules directory.');
const { createServer, build } = await import(pathToFileURL(resolve(dependencyRoot, 'vite/dist/node/index.js')).href);
const facings = ['down', 'left', 'right', 'up'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = [
  'packages/world/src/map/street.ts',
  'packages/world/src/kenney-urban.ts',
  'packages/world/src/scenes/street-scene.ts',
  'packages/world/assets/third-party/kenney-rpg-urban/tilemap.png',
];
const authoringPaths = [
  'source/artist-grid.json', 'source/idle-geometry.json', 'source/avatar-1.blend',
  'source/authoring.py', 'source/export_svg.py', 'source/readback.py',
  'source/blender-readback.json', 'source/source_contract.py', 'source/verify_source.py',
  'svg/down/idle.svg', 'svg/left/idle.svg', 'svg/right/idle.svg', 'svg/up/idle.svg',
];

function worktreeMetadata() {
  const git = (...args) => execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' }).trim();
  return { branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'), path: git('rev-parse', '--show-toplevel') };
}

function metadata() {
  const reviewPath = resolve(previewRoot, '../review/user-decisions.json');
  const reviewBytes = readFileSync(reviewPath);
  const review = JSON.parse(reviewBytes.toString('utf8'));
  const reference = (relative, expectedHash, role) => {
    const path = resolve(previewRoot, relative);
    const bytes = readFileSync(path);
    const sha256 = digest(bytes);
    if (sha256 !== expectedHash) throw new Error(`The approved ${role} reference hash changed.`);
    return { path, sha256, role, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), url: `/@fs/${path}?v=${sha256}` };
  };
  const frames = Object.fromEntries(facings.map((facing) => {
    const path = resolve(previewRoot, `../frames/${facing}/idle.png`);
    if (!existsSync(path)) return [facing, { path, present: false }];
    const bytes = readFileSync(path);
    const sha256 = digest(bytes);
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Invalid PNG: ${facing}`);
    return [facing, { path, present: true, sha256, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), url: `/@fs/${path}?v=${sha256}` }];
  }));
  return {
    preview: 'idle-v6-isolated-phaser-draft', repositoryRoot, worktree: worktreeMetadata(),
    phaserVersion: JSON.parse(readFileSync(resolve(dependencyRoot, 'phaser/package.json'), 'utf8')).version,
    frames, reviewStatus: review.status, readyForReview: review.readyForReview === true,
    reviewDecision: { path: reviewPath, sha256: digest(reviewBytes), userDecision: review.userDecision, readyForReview: review.readyForReview === true },
    references: {
      style: reference('../../reference/approved-concept-turnaround.png', review.spriteStyleSha256, 'sprite style, medium proportions and elevated viewpoint'),
      concept: reference('../../concept/avatar-1-concept-v2.png', review.conceptSha256, 'character identity and costume'),
    },
    authoringSources: authoringPaths.map((path) => {
      const fullPath = resolve(previewRoot, '..', path);
      return existsSync(fullPath) ? { path, present: true, sha256: digest(readFileSync(fullPath)) } : { path, present: false };
    }),
    townSources: sourcePaths.map((path) => ({ path, sha256: digest(readFileSync(resolve(repositoryRoot, path))) })),
    previewSources: ['main.ts', 'style.css', 'index.html', 'serve.mjs'].map((path) => ({ path, sha256: digest(readFileSync(resolve(previewRoot, path))) })),
    authoringStage: review.readyForReview === true ? 'isolated-idle-review-candidate' : 'internal-refinement',
  };
}

const config = {
  root: previewRoot, configFile: false, envDir: false, publicDir: false,
  cacheDir: resolve(previewRoot, '.vite'),
  resolve: { alias: {
    phaser: resolve(dependencyRoot, 'phaser/dist/phaser.esm.js'),
    '@strkworld/shared': resolve(repositoryRoot, 'packages/shared/src/index.ts'),
  } },
  optimizeDeps: { include: ['phaser'] },
  plugins: [{ name: 'avatar-draft-evidence', configureServer(server) {
    server.middlewares.use('/__preview_meta', (_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      try { response.end(JSON.stringify(metadata())); }
      catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
    });
  } }],
  server: { host: '127.0.0.1', port: Number(process.env.STRKWORLD_PREVIEW_PORT || 5186), strictPort: true,
    fs: { allow: [repositoryRoot, dependencyRoot] } },
  build: { outDir: resolve(previewRoot, '.build-check'), emptyOutDir: true },
};

if (process.argv.includes('--metadata-check')) {
  console.log(JSON.stringify(metadata(), null, 2));
} else if (process.argv.includes('--build-check')) {
  await build(config);
} else {
  const server = await createServer(config);
  await server.listen();
  server.printUrls();
  console.log(`Isolated avatar preview from ${repositoryRoot}`);
  const close = async () => { await server.close(); process.exit(0); };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
