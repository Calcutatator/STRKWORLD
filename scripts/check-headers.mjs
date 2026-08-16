#!/usr/bin/env node
/**
 * D-005 header test.
 *
 * docs/DECISIONS.md D-005 says the rule must live "in the deployment config as
 * a comment and a header test". This is the header test.
 *
 * `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp` break the `postMessage` popups
 * and cross-origin iframes that web wallets use. The standards fix,
 * `COOP: restrict-properties`, ships in no browser. We do no in-browser
 * proving, so we never need them. Setting them closes the door to web wallets
 * silently — the app keeps building and the connect flow just stops working.
 *
 * Two phases:
 *
 *   1. STATIC — no file that can take effect at runtime may *set* one of these
 *      headers. Comments and markdown are exempt: the repo has to be able to
 *      talk about the rule in order to state it.
 *
 *   2. LIVE — build apps/web for production, serve the real artifact with
 *      `vite preview`, and assert the actual responses carry neither header,
 *      and that the built HTML carries no equivalent <meta http-equiv>.
 *
 * WHAT THIS DOES NOT PROVE. `vite preview` is not the production host. It
 * exercises this repo's own serving config (`preview.headers` / `server.headers`
 * in a vite config, and anything a build plugin injects into the HTML), which
 * is the part we control today. Once a hosting provider is chosen, its header
 * config becomes a new place these can appear, and the chosen host's config
 * files must be added to CONFIG_ROOTS below and the deployed origin re-tested
 * against this same list. See docs/OPS.md.
 */

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(REPO, 'apps', 'web');
const DIST = join(WEB, 'dist');
const PORT = Number(process.env.HEADER_TEST_PORT ?? 4319);

/** Header names that must never be sent, in the casing browsers normalise to. */
const FORBIDDEN_HEADERS = [
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
];

/** Source-text patterns that indicate one of the above is being introduced. */
const FORBIDDEN_PATTERNS = [
  /Cross-Origin-Opener-Policy/i,
  /Cross-Origin-Embedder-Policy/i,
  /crossOriginOpenerPolicy/i,
  /crossOriginEmbedderPolicy/i,
  /require-corp/i,
  /credentialless/i,
];

/** Directories never scanned: not shipped, or not ours. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite', 'coverage']);

/**
 * Files that carry these strings as *data* — the checkers themselves. Both
 * exist to forbid the headers, so both necessarily name them outside a comment.
 */
const SELF_REFERENTIAL = new Set([
  join('scripts', 'check-headers.mjs'),
  join('scripts', 'check-invariants.sh'),
]);

/**
 * Extensions that cannot set an HTTP header no matter what they contain.
 * Markdown is documentation; the decision log and AGENTS.md must be able to
 * name the headers in order to ban them.
 */
const INERT_EXTENSIONS = new Set(['.md', '.lock', '.png', '.jpg', '.svg', '.ico', '.woff', '.woff2']);

/** Comment prefixes across the config languages a host config might use. */
const COMMENT_PREFIXES = ['#', '//', '/*', '*/', '*', '<!--', ';', '--'];

/**
 * Where a chosen host would put its header config. Listed so that adding one
 * later is a one-line change and so the list is discoverable during review.
 * Everything under REPO is scanned anyway; this is documentation of intent.
 */
const CONFIG_ROOTS = [
  'apps/web',            // vite config, index.html, any static-host config
  'deploy',              // container and platform config
  '.github/workflows',   // CI, which can serve the app
  // Add on provider selection: _headers, netlify.toml, vercel.json,
  // firebase.json, nginx.conf, Caddyfile, static.json, wrangler.toml.
];

let failures = 0;
const fail = (message) => { failures += 1; console.error(`FAIL  ${message}`); };
const ok = (message) => console.log(` ok   ${message}`);

// ---------------------------------------------------------------- phase 1

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function isComment(line) {
  const trimmed = line.trim();
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function staticScan() {
  let scanned = 0;
  let hits = 0;

  for (const file of walk(REPO)) {
    const rel = relative(REPO, file);
    if (SELF_REFERENTIAL.has(rel)) continue;
    if (INERT_EXTENSIONS.has(extname(file))) continue;

    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // binary or unreadable; it cannot set a header either
    }
    scanned += 1;

    text.split('\n').forEach((line, index) => {
      if (isComment(line)) return;
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(line)) {
          hits += 1;
          fail(`${rel}:${index + 1} introduces a cross-origin isolation header`);
          console.error(`      ${line.trim()}`);
          console.error('      See docs/DECISIONS.md D-005. These break web wallets.');
          return;
        }
      }
    });
  }

  if (hits === 0) ok(`static scan: ${scanned} files, no config sets an isolation header`);
  console.log(`      config roots watched: ${CONFIG_ROOTS.join(', ')}`);
}

// ---------------------------------------------------------------- phase 2

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', rejectRun);
    child.on('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited ${code}`))));
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`preview server did not start within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function assertResponseHeaders(label, response) {
  let clean = true;
  for (const header of FORBIDDEN_HEADERS) {
    const value = response.headers.get(header);
    if (value !== null) {
      clean = false;
      fail(`${label} responded with ${header}: ${value}`);
    }
  }
  return clean;
}

function distAssets() {
  const assets = [];
  const walkDist = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walkDist(full);
      else assets.push('/' + relative(DIST, full).split(sep).join('/'));
    }
  };
  walkDist(DIST);
  return assets;
}

async function liveScan() {
  console.log('      building apps/web for production...');
  await run('npm', ['run', 'build', '--workspace=@strkworld/web'], { cwd: REPO });

  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  if (/http-equiv\s*=\s*["']?Cross-Origin-(Opener|Embedder)-Policy/i.test(html)) {
    fail('built index.html carries a <meta http-equiv> cross-origin isolation header');
  } else {
    ok('built index.html sets no equivalent <meta http-equiv>');
  }

  const preview = spawn(
    'npx',
    ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: WEB, stdio: 'ignore' },
  );

  try {
    const origin = `http://127.0.0.1:${PORT}`;
    await waitForServer(`${origin}/index.html`, 30_000);

    const paths = ['/', '/index.html', ...distAssets()];
    let clean = true;
    for (const path of paths) {
      const response = await fetch(origin + path);
      clean = assertResponseHeaders(`GET ${path}`, response) && clean;
    }
    if (clean) ok(`live serve: ${paths.length} production responses, no isolation headers`);
  } finally {
    preview.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------- main

console.log('STRKWORLD cross-origin isolation header test (D-005)');
console.log();
staticScan();
await liveScan();
console.log();

if (failures === 0) {
  console.log('No cross-origin isolation headers. Web wallets stay possible.');
  process.exit(0);
}
console.error(`${failures} violation(s). COOP/COEP break web wallets — see docs/DECISIONS.md D-005.`);
process.exit(1);
