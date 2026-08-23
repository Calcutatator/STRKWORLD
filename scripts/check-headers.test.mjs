/**
 * Fixtures for the D-005 static scan (scripts/check-headers.mjs).
 *
 * Executable/configuration syntaxes are scanned raw, including comments. The
 * fixtures below pin the grammar cases that made the former hand-rolled shell
 * and YAML parser unsafe: nested substitutions, odd continuations, heredocs,
 * multiline scalars and ANSI-C quoting.
 *
 * This file is in SELF_REFERENTIAL in check-headers.mjs: it necessarily
 * contains the forbidden strings as test data.
 */

import { describe, expect, it } from 'vitest';
import { scanText, stripComments, syntaxFor } from './check-headers.mjs';

const COOP = 'Cross-Origin-Opener-Policy';
const COEP = 'Cross-Origin-Embedder-Policy';

describe('violations that must be caught', () => {
  it('catches a --header CLI flag in a shell script', () => {
    const script = [
      '#!/usr/bin/env bash',
      'curl -sSf https://example.test \\',
      `  --header "${COOP}: same-origin" \\`,
      `  --header "${COEP}: require-corp"`,
    ].join('\n');
    const violations = scanText('deploy/smoke.sh', script);
    expect(violations.map((v) => v.line)).toEqual([3, 4]);
  });

  it('catches a --header flag inside a workflow YAML run block', () => {
    const workflow = [
      'jobs:',
      '  serve:',
      '    steps:',
      '      - run: |',
      `          npx serve --header "${COOP}: same-origin" ./dist`,
    ].join('\n');
    expect(scanText('.github/workflows/deploy.yml', workflow)).toHaveLength(1);
  });

  it('catches a header nested in shell command substitutions', () => {
    const script = [
      'value=$(printf %s "$(printf %s safe)")',
      `curl --header "${COOP}: same-origin" "$value"`,
    ].join('\n');
    expect(scanText('deploy/smoke.sh', script).map((violation) => violation.line)).toEqual([2]);
  });

  it('catches headers after odd three- and five-backslash continuations', () => {
    const script = [
      'printf %s safe\\\\\\',
      `# continued data --header "${COOP}: same-origin"`,
      'printf %s safe\\\\\\\\\\',
      `# continued data --header "${COEP}: require-corp"`,
    ].join('\n');
    expect(scanText('deploy/smoke.sh', script).map((violation) => violation.line)).toEqual([2, 4]);
  });

  it('catches a header in an unquoted heredoc expansion', () => {
    const script = [
      'cat <<EOF',
      `$(curl --header "${COOP}: same-origin")`,
      'EOF',
    ].join('\n');
    expect(scanText('deploy/smoke.sh', script).map((violation) => violation.line)).toEqual([2]);
  });

  it('catches a header in a YAML multiline double-quoted scalar', () => {
    const workflow = [
      'env:',
      '  note: "',
      `    # ${COEP}: require-corp`,
      '  "',
    ].join('\n');
    expect(scanText('.github/workflows/deploy.yml', workflow).map((violation) => violation.line)).toEqual([3]);
  });

  it('catches a header in ANSI-C shell quoting after an escaped quote', () => {
    const script = [
      `printf '%s' $'safe\\'`,
      `#still-quoted'; curl --header "${COOP}: same-origin"`,
    ].join('\n');
    expect(scanText('deploy/smoke.sh', script).map((violation) => violation.line)).toEqual([2]);
  });

  it('catches a header after an in-word hash in a workflow command', () => {
    const workflow = `run: echo safe#still-word && curl --header "${COEP}: require-corp"`;
    expect(scanText('.github/workflows/deploy.yml', workflow).map((violation) => violation.line)).toEqual([1]);
  });

  it('catches a header after a YAML-escaped space', () => {
    const workflow = `run: echo safe\\ # ${COOP}: same-origin`;
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
    expect(scanText('deploy/Unknownfile', `# ${COOP}: same-origin`)).toHaveLength(1);
  });
});

describe('real comments that stay exempt only where syntax is owned', () => {
  it('exempts prose inside an HTML block comment, across several lines', () => {
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

  it('exempts prose inside a JS block comment, with and without leading stars', () => {
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

  it.each([
    ['shell', 'deploy/smoke.sh'],
    ['YAML', '.github/workflows/ci.yml'],
  ])('raw-scans %s comments', (_label, file) => {
    expect(scanText(file, `# explanatory comment: ${COOP}: same-origin`)).toHaveLength(1);
  });
});

describe('stripComments safety properties', () => {
  it('does not treat // inside a string as a comment', () => {
    const [line] = stripComments('const u = "http://x.test"; // trailing', SYNTAX_SLASH());
    expect(line).toContain('http://x.test');
    expect(line).not.toContain('trailing');
  });

  it('errs toward scanning more when a quote is unterminated', () => {
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

  it.each(['deploy/smoke.sh', '.github/workflows/ci.yml'])('does not erase raw %s text', (file) => {
    const source = [
      `# comment ${COOP}: same-origin`,
      'value=$(printf %s "$(nested)") # trailing',
      'quoted: "',
      `  ${COEP}: require-corp`,
      '"',
    ].join('\n');
    expect(stripComments(source, syntaxFor(file))).toEqual(source.split('\n'));
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

  it('raw-scans shell and YAML rather than claiming comment grammar', () => {
    expect(syntaxFor('a.sh')).toEqual({ line: [], block: [] });
    expect(syntaxFor('a.yml')).toEqual({ line: [], block: [] });
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
