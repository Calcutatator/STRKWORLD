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
 *      headers. Real comments and markdown are exempt: the repo has to be able
 *      to talk about the rule in order to state it.
 *
 *   2. LIVE — build apps/web for production, serve the real artifact with
 *      `vite preview`, and assert the actual responses carry neither header,
 *      and that the built HTML carries no equivalent <meta http-equiv>.
 *
 * COMMENT DETECTION IS FILE-TYPE AWARE, and that is load-bearing rather than
 * tidiness. An earlier version treated any line starting with one of a fixed
 * set of prefixes as a comment, which produced two defects, both now covered
 * by fixtures in scripts/check-headers.test.mjs:
 *
 *   - `--` was treated as a comment everywhere, so a shell or workflow line
 *     reading `--header "Cross-Origin-Opener-Policy: same-origin"` was skipped
 *     as if it were SQL. `--` is a comment in .sql and .lua and nowhere else.
 *   - Only the *first* line of a block comment was exempt, so the prose inside
 *     a `<!-- -->` or block comment was scanned — meaning the explanatory
 *     comment D-005 asks for could itself fail the test.
 *
 * The stripper below tracks block-comment state across lines and quoted
 * strings within a line. Where it is unsure it errs toward scanning MORE text,
 * never less: an unknown file type gets no comment syntax at all, and an
 * unterminated quote leaves the rest of the line scanned.
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
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(REPO, 'apps', 'web');
const DIST = join(WEB, 'dist');
const PORT = Number(process.env.HEADER_TEST_PORT ?? 4319);

/** Header names that must never be sent, in the casing browsers normalise to. */
export const FORBIDDEN_HEADERS = [
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
];

/** Source-text patterns that indicate one of the above is being introduced. */
export const FORBIDDEN_PATTERNS = [
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
 * Files that carry these strings as *data* — the checkers and their fixtures.
 * All three exist to forbid the headers, so all three necessarily name them
 * outside a comment.
 */
const SELF_REFERENTIAL = new Set([
  join('scripts', 'check-headers.mjs'),
  join('scripts', 'check-headers.test.mjs'),
  join('scripts', 'check-invariants.sh'),
]);

/**
 * Extensions that cannot set an HTTP header no matter what they contain.
 * Markdown is documentation; the decision log and AGENTS.md must be able to
 * name the headers in order to ban them.
 */
const INERT_EXTENSIONS = new Set(['.md', '.lock', '.png', '.jpg', '.svg', '.ico', '.woff', '.woff2']);

/**
 * Comment syntaxes. `line` tokens comment to end of line; `block` pairs nest
 * not at all and run until their close token, across lines.
 */
const SYNTAXES = {
  none: { line: [], block: [] },
  hash: { line: ['#'], block: [] },
  shell: { line: ['#'], block: [], shellHashComments: true },
  slash: { line: ['//'], block: [['/*', '*/']] },
  html: { line: [], block: [['<!--', '-->']] },
  sql: { line: ['--'], block: [['/*', '*/']] },
  lua: { line: ['--'], block: [['--[[', ']]']] },
  ini: { line: ['#', ';'], block: [] },
};

const SYNTAX_BY_EXTENSION = {
  '.js': 'slash', '.mjs': 'slash', '.cjs': 'slash',
  '.ts': 'slash', '.mts': 'slash', '.cts': 'slash', '.tsx': 'slash', '.jsx': 'slash',
  '.css': 'slash', '.scss': 'slash', '.less': 'slash',
  // tsconfig and friends are JSON with comments in practice.
  '.json': 'slash', '.json5': 'slash', '.jsonc': 'slash',
  '.yml': 'hash', '.yaml': 'hash',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ksh': 'shell',
  '.toml': 'hash', '.conf': 'hash', '.cfg': 'hash', '.properties': 'hash',
  '.env': 'hash', '.example': 'hash', '.dockerfile': 'hash', '.nginx': 'hash',
  '.py': 'hash', '.rb': 'hash', '.pl': 'hash',
  '.ini': 'ini',
  '.html': 'html', '.htm': 'html', '.xml': 'html', '.vue': 'html', '.svelte': 'html',
  '.sql': 'sql',
  '.lua': 'lua',
};

const SYNTAX_BY_BASENAME = {
  'Dockerfile': 'hash', 'Containerfile': 'hash', 'Makefile': 'hash',
  'Caddyfile': 'hash', 'Procfile': 'hash', 'nginx.conf': 'hash',
  '.gitignore': 'hash', '.dockerignore': 'hash', '.npmrc': 'hash',
  '.editorconfig': 'hash', '_headers': 'hash', '_redirects': 'hash',
};

/**
 * Unknown file types get NO comment syntax. A security gate that cannot parse
 * a file must scan all of it rather than exempt text it does not understand.
 */
export function syntaxFor(filePath) {
  const base = basename(filePath);
  if (base in SYNTAX_BY_BASENAME) return SYNTAXES[SYNTAX_BY_BASENAME[base]];
  if (base.startsWith('.env')) return SYNTAXES.hash;
  if (base.startsWith('Dockerfile')) return SYNTAXES.hash;
  const ext = extname(base).toLowerCase();
  if (ext in SYNTAX_BY_EXTENSION) return SYNTAXES[SYNTAX_BY_EXTENSION[ext]];
  return SYNTAXES.none;
}

/**
 * Returns one entry per input line holding only that line's NON-comment text.
 * Block-comment state carries across lines; quote state does not (an
 * unterminated quote must not silently blank the rest of the file).
 */
export function stripComments(text, syntax) {
  const lines = text.split('\n');
  const stripped = [];
  let openBlockCloseToken = null;
  let shellContinuationInsideWord = false;

  for (const line of lines) {
    let code = '';
    let quote = null;
    let i = 0;
    let lineCommentStarted = false;

    while (i < line.length) {
      if (openBlockCloseToken !== null) {
        const close = line.indexOf(openBlockCloseToken, i);
        if (close === -1) { i = line.length; break; }
        i = close + openBlockCloseToken.length;
        openBlockCloseToken = null;
        continue;
      }

      const char = line[i];

      if (quote !== null) {
        code += char;
        if (char === '\\') { code += line[i + 1] ?? ''; i += 2; continue; }
        if (char === quote) quote = null;
        i += 1;
        continue;
      }

      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        code += char;
        i += 1;
        continue;
      }

      if (syntax.line.some((token) => isLineCommentAt(
        line,
        i,
        token,
        syntax,
        shellContinuationInsideWord,
      ))) {
        lineCommentStarted = true;
        i = line.length;
        break;
      }

      const block = syntax.block.find(([open]) => line.startsWith(open, i));
      if (block) {
        openBlockCloseToken = block[1];
        i += block[0].length;
        continue;
      }

      code += char;
      i += 1;
    }

    stripped.push(code);
    shellContinuationInsideWord = Boolean(
      syntax.shellHashComments
      && !lineCommentStarted
      && continuesShellWord(line),
    );
  }

  return stripped;
}

function isLineCommentAt(line, index, token, syntax, shellContinuationInsideWord) {
  if (!line.startsWith(token, index)) return false;
  if (token !== '#') return true;
  if (syntax.shellHashComments && index === 0 && shellContinuationInsideWord) {
    return false;
  }
  if (
    syntax.shellHashComments
    && index > 0
    && /\s/.test(line[index - 1])
    && isEscaped(line, index - 1)
  ) {
    return false;
  }
  // Hash comments begin at a token boundary. Treating an in-word hash as the
  // start of a comment can hide effective shell or workflow code after it.
  return index === 0 || /\s/.test(line[index - 1]);
}

function isEscaped(line, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function continuesShellWord(line) {
  let backslashes = 0;
  for (let cursor = line.length - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  if (backslashes % 2 === 0) return false;
  const before = line[line.length - backslashes - 1];
  return before !== undefined && !/[\s;&|()<>]/.test(before);
}

/**
 * Core of the static phase, exported so scripts/check-headers.test.mjs can
 * pin the bypasses that once got through. Returns `{line, text}` violations.
 */
export function scanText(filePath, text) {
  if (INERT_EXTENSIONS.has(extname(filePath).toLowerCase())) return [];
  const code = stripComments(text, syntaxFor(filePath));
  const violations = [];
  code.forEach((line, index) => {
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(line))) {
      violations.push({ line: index + 1, text: text.split('\n')[index].trim() });
    }
  });
  return violations;
}

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

function staticScan() {
  let scanned = 0;
  let hits = 0;

  for (const file of walk(REPO)) {
    const rel = relative(REPO, file);
    if (SELF_REFERENTIAL.has(rel)) continue;
    if (INERT_EXTENSIONS.has(extname(file).toLowerCase())) continue;

    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // binary or unreadable; it cannot set a header either
    }
    scanned += 1;

    for (const violation of scanText(file, text)) {
      hits += 1;
      fail(`${rel}:${violation.line} introduces a cross-origin isolation header`);
      console.error(`      ${violation.text}`);
      console.error('      See docs/DECISIONS.md D-005. These break web wallets.');
    }
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

async function main() {
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
}

// Only run the gate when executed directly; the test file imports the pure
// functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
