import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Check 8, the privacy register gate (D-020), against the Vault's two routes
 * (D-077, widened by D-079 and D-081). The script runs from a scratch copy of the repository shape holding
 * only the register and the decision log, so every other check has nothing to
 * read; only check 8's own lines are asserted.
 */

const script = fileURLToPath(new URL('./check-invariants.sh', import.meta.url));
const registerPath = new URL('../packages/shared/src/privacy-grades.ts', import.meta.url);
const decisionsPath = new URL('../docs/DECISIONS.md', import.meta.url);
const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runCheck(editRegister = (text) => text) {
  const directory = await mkdtemp(join(tmpdir(), 'strkworld-invariants-test-'));
  directories.push(directory);
  await mkdir(join(directory, 'packages/shared/src'), { recursive: true });
  await mkdir(join(directory, 'docs'), { recursive: true });
  await writeFile(join(directory, 'packages/shared/src/privacy-grades.ts'), editRegister(await readFile(registerPath, 'utf8')));
  await writeFile(join(directory, 'docs/DECISIONS.md'), await readFile(decisionsPath, 'utf8'));
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', () => undefined);
    child.once('error', reject);
    child.once('close', () => resolve(Buffer.concat(stdout).toString().replace(/\x1b\[[0-9;]*m/g, '')));
  });
}

/** Replace one field of one route's entry, and nothing else. */
function editEntry(route, pattern, replacement) {
  return (text) => {
    const start = text.indexOf(`route: '${route}'`);
    if (start < 0) throw new Error(`no ${route} entry`);
    const end = text.indexOf('\n  },', start);
    const entry = text.slice(start, end);
    const edited = entry.replace(pattern, replacement);
    if (edited === entry) throw new Error(`no change to ${route}`);
    return text.slice(0, start) + edited + text.slice(end);
  };
}

describe('check 8: the privacy register gate, with the Vault routes (D-077, D-079, D-081)', () => {
  it('passes the register as committed', async () => {
    const output = await runCheck();
    expect(output).toContain('ok   every privacy deviation is approved');
    expect(output).not.toContain('player-facing copy');
    expect(output).not.toContain('could not parse the privacy register');
  }, 30_000);

  it('fails a Vault route with no recorded approval', async () => {
    const output = await runCheck(editEntry('vault.supply', /approvedBy: 'calc'/, 'approvedBy: null'));
    expect(output).toMatch(/FAIL\s+privacy deviation\(s\) with no recorded approval: vault\.supply \(anonymous\)/);
  }, 30_000);

  it('passes an approved Vault route with no pre-commit line: copy is not part of the gate (D-118)', async () => {
    const output = await runCheck(editEntry('vault.redeem', /disclosure:\s*\n\s*'[^']*',/, 'disclosure: null,'));
    expect(output).toContain('ok   every privacy deviation is approved');
    expect(output).not.toMatch(/FAIL\s+(?:privacy|approved deviation|could not parse)/);
  }, 30_000);

  it('still parses the register now its Vault observables name no token (D-081)', async () => {
    const register = await readFile(registerPath, 'utf8');
    for (const route of ['vault.supply', 'vault.redeem']) {
      const start = register.indexOf(`route: '${route}'`);
      const entry = register.slice(start, register.indexOf('\n  },', start));
      expect(entry, route).toMatch(/in the Vesu Prime pool or a curated pool/);
      expect(entry, route).not.toMatch(/[{}]/);
    }
    const output = await runCheck();
    expect(output).not.toContain('could not parse the privacy register');
    expect(output).toContain('ok   every privacy deviation is approved');
  }, 30_000);
});
