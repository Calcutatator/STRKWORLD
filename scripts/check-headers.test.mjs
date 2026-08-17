/**
 * Fixtures for the D-005 static scan (scripts/check-headers.mjs).
 *
 * Two of these pin real bypasses found in review rather than hypotheticals:
 * a `--header` CLI flag skipped as a SQL comment, and prose inside a block
 * comment being scanned. Both are marked BYPASS below. Do not delete them —
 * the whole point of D-005 is that the failure it guards against is silent,
 * so a hole in the guard is silent twice over.
 *
 * This file is in SELF_REFERENTIAL in check-headers.mjs: it necessarily
 * contains the forbidden strings as test data.
 */

import { describe, expect, it } from 'vitest';
import { scanText, stripComments, syntaxFor } from './check-headers.mjs';

const COOP = 'Cross-Origin-Opener-Policy';
const COEP = 'Cross-Origin-Embedder-Policy';

describe('violations that must be caught', () => {
  it('BYPASS: a --header CLI flag in a shell script is not a SQL comment', () => {
    const script = [
      '#!/usr/bin/env bash',
      'curl -sSf https://example.test \\',
      `  --header "${COOP}: same-origin" \\`,
      `  --header "${COEP}: require-corp"`,
    ].join('\n');
    const violations = scanText('deploy/smoke.sh', script);
    expect(violations.map((v) => v.line)).toEqual([3, 4]);
  });

  it('BYPASS: the same flag inside a workflow YAML run block', () => {
    const workflow = [
      'jobs:',
      '  serve:',
      '    steps:',
      '      - run: |',
      `          npx serve --header "${COOP}: same-origin" ./dist`,
    ].join('\n');
    expect(scanText('.github/workflows/deploy.yml', workflow)).toHaveLength(1);
  });

  it('catches a vite preview.headers entry', () => {
    const config = [
      "import { defineConfig } from 'vite';",
      'export default defineConfig({',
      `  preview: { headers: { '${COOP}': 'same-origin' } },`,
      '});',
    ].join('\n');
    expect(scanText('apps/web/vite.config.ts', config)).toHaveLength(1);
  });

  it('catches a setHeader call', () => {
    const source = `res.setHeader('${COEP}', 'require-corp');`;
    expect(scanText('apps/web/server.ts', source)).toHaveLength(1);
  });

  it('catches a meta http-equiv outside a comment', () => {
    const html = `<head><meta http-equiv="${COOP}" content="same-origin" /></head>`;
    expect(scanText('apps/web/index.html', html)).toHaveLength(1);
  });

  it('catches the camelCase property form', () => {
    expect(scanText('deploy/host.js', 'crossOriginEmbedderPolicy: "require-corp"')).toHaveLength(1);
  });

  it('does not lose a violation that follows a URL on the same line', () => {
    const source = `fetch("http://x.test"); res.setHeader("${COOP}", "same-origin");`;
    expect(scanText('deploy/host.js', source)).toHaveLength(1);
  });

  it('scans unknown file types in full, exempting nothing', () => {
    // No known comment syntax, so a `#` line is still scanned. A gate that
    // cannot parse a file must not exempt text it does not understand.
    expect(scanText('deploy/Unknownfile', `# ${COOP}: same-origin`)).toHaveLength(1);
  });
});

describe('real comments that must stay exempt', () => {
  it('BYPASS: prose inside an HTML block comment, across several lines', () => {
    // The D-005 comment the decision itself asks for. Bare `require-corp` is
    // in FORBIDDEN_PATTERNS, so an unexempted block body would fail here.
    const html = [
      '<!doctype html>',
      '<!--',
      `  Never ask the host for ${COOP}: same-origin or`,
      `  ${COEP}: require-corp. They break the postMessage popups web`,
      '  wallets rely on. See docs/DECISIONS.md D-005.',
      '-->',
      '<html lang="en"><head></head><body></body></html>',
    ].join('\n');
    expect(scanText('apps/web/index.html', html)).toEqual([]);
  });

  it('BYPASS: prose inside a JS block comment, with and without leading stars', () => {
    const source = [
      '/**',
      ` * Never set ${COOP}: same-origin.`,
      ' */',
      '/*',
      `   Nor ${COEP}: require-corp — no leading star on this line.`,
      '*/',
      'export const safe = true;',
    ].join('\n');
    expect(scanText('deploy/host.mjs', source)).toEqual([]);
  });

  it('exempts hash comments in a Dockerfile', () => {
    const dockerfile = [
      `# This service must never send ${COOP}: same-origin or`,
      `# ${COEP}: require-corp. See docs/DECISIONS.md D-005.`,
      'FROM node:22.12-alpine',
    ].join('\n');
    expect(scanText('deploy/backend/Dockerfile', dockerfile)).toEqual([]);
  });

  it('exempts a genuine SQL comment, where -- really is a comment', () => {
    expect(scanText('deploy/audit.sql', `-- never set ${COOP}\nSELECT 1;`)).toEqual([]);
  });

  it('exempts markdown entirely', () => {
    expect(scanText('docs/DECISIONS.md', `Never set ${COOP}: same-origin.`)).toEqual([]);
  });

  it('exempts a hash comment in a YAML workflow', () => {
    expect(scanText('.github/workflows/ci.yml', `# asserts no ${COOP} is sent`)).toEqual([]);
  });
});

describe('stripComments safety properties', () => {
  it('does not treat // inside a string as a comment', () => {
    const [line] = stripComments('const u = "http://x.test"; // trailing', SYNTAX_SLASH());
    expect(line).toContain('http://x.test');
    expect(line).not.toContain('trailing');
  });

  it('errs toward scanning more when a quote is unterminated', () => {
    // An apostrophe in prose must not blank the rest of the line, or a
    // violation after it would vanish. Scanning too much is the safe failure.
    const source = `it's fine; setHeader("${COOP}", "same-origin")`;
    expect(scanText('deploy/host.js', source)).toHaveLength(1);
  });

  it('does not carry quote state across lines', () => {
    const source = ["const a = \"it's\";", `setHeader("${COOP}", "same-origin");`].join('\n');
    expect(scanText('deploy/host.js', source).map((v) => v.line)).toEqual([2]);
  });

  it('resumes scanning after a block comment closes', () => {
    const source = ['/* harmless */', `setHeader("${COEP}", "require-corp");`].join('\n');
    expect(scanText('deploy/host.js', source).map((v) => v.line)).toEqual([2]);
  });

  it('reports the original line text, not the stripped text', () => {
    const source = `  setHeader("${COOP}", "same-origin");  `;
    expect(scanText('deploy/host.js', source)[0].text).toBe(`setHeader("${COOP}", "same-origin");`);
  });
});

describe('syntaxFor', () => {
  it('gives -- line comments only to sql and lua', () => {
    expect(syntaxFor('a.sql').line).toContain('--');
    expect(syntaxFor('a.lua').line).toContain('--');
    expect(syntaxFor('a.sh').line).not.toContain('--');
    expect(syntaxFor('a.yml').line).not.toContain('--');
    expect(syntaxFor('Dockerfile').line).not.toContain('--');
  });

  it('recognises extensionless and dotfile config names', () => {
    expect(syntaxFor('Dockerfile').line).toEqual(['#']);
    expect(syntaxFor('.dockerignore').line).toEqual(['#']);
    expect(syntaxFor('.env.production.example').line).toEqual(['#']);
    expect(syntaxFor('_headers').line).toEqual(['#']);
  });

  it('falls back to no comment syntax for unknown types', () => {
    expect(syntaxFor('mystery.qqq')).toEqual({ line: [], block: [] });
  });
});

function SYNTAX_SLASH() {
  return syntaxFor('x.js');
}
