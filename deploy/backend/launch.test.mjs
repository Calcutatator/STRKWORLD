import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directories = [];
const launcher = fileURLToPath(new URL('./launch.mjs', import.meta.url));
const configurationError = [
  'strkworld-backend: cannot start — compiled entry is missing or invalid.',
  '',
  '  Build the backend image from the repository root so the compiled',
  '  composition root is copied into the expected path.',
  '',
].join('\n');

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('standalone Backend launcher', () => {
  it('imports a regular entry without launcher output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strkworld-backend-entry-success-'));
    directories.push(root);
    const entry = join(root, 'entry.mjs');
    await writeFile(entry, 'process.stdout.write("backend startup marker");\n');

    const result = spawnSync(process.execPath, [launcher], {
      encoding: 'utf8',
      env: { ...process.env, BACKEND_ENTRY: entry },
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('backend startup marker');
    expect(result.stderr).toBe('');
  });

  it('rejects missing and non-regular entries before importing the Backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strkworld-backend-entry-'));
    directories.push(root);
    const directory = join(root, 'directory');
    const directoryLink = join(root, 'directory-link');
    await mkdir(directory);
    await symlink(directory, directoryLink, 'dir');

    for (const entry of [join(root, 'missing.mjs'), directory, directoryLink]) {
      const result = spawnSync(process.execPath, [launcher], {
        encoding: 'utf8',
        env: { ...process.env, BACKEND_ENTRY: entry },
      });

      expect(result.status).toBe(78);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(configurationError);
      expect(result.stderr).not.toContain(entry);
      expect(result.stderr).not.toContain(process.cwd());
      expect(result.stderr).not.toMatch(/\bERR_[A-Z_]+\b/);
      expect(result.stderr).not.toContain('\n    at ');
    }
  });

  it('keeps a regular-file admission race inside the generic configuration boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strkworld-backend-entry-race-'));
    directories.push(root);
    const entry = join(root, 'entry.mjs');
    const raceHook = join(root, 'replace-entry-after-stat.mjs');
    await writeFile(entry, 'process.stdout.write("backend imported");\n');
    await writeFile(raceHook, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const originalStatSync = fs.statSync;',
      'let replaced = false;',
      'fs.statSync = function statThenReplace(path, ...args) {',
      '  const result = originalStatSync(path, ...args);',
      '  if (!replaced && path === process.env.BACKEND_ENTRY) {',
      '    replaced = true;',
      '    fs.rmSync(path);',
      '    fs.mkdirSync(path);',
      '  }',
      '  return result;',
      '};',
      'syncBuiltinESMExports();',
      '',
    ].join('\n'));

    const result = spawnSync(process.execPath, ['--import', raceHook, launcher], {
      encoding: 'utf8',
      env: { ...process.env, BACKEND_ENTRY: entry },
    });

    expect(result.status).toBe(78);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(configurationError);
    expect(result.stderr).not.toContain(entry);
    expect(result.stderr).not.toContain(root);
    expect(result.stderr).not.toContain(process.cwd());
    expect(result.stderr).not.toMatch(/\bERR_[A-Z_]+\b/);
    expect(result.stderr).not.toContain('\n    at ');
  });

  it('keeps an entry permission race inside the generic configuration boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strkworld-backend-entry-permission-'));
    directories.push(root);
    const directEntry = join(root, 'direct-entry.mjs');
    const linkedTarget = join(root, 'linked-target.mjs');
    const linkedEntry = join(root, 'linked-entry.mjs');
    const raceHook = join(root, 'revoke-entry-after-stat.mjs');
    await writeFile(directEntry, 'process.stdout.write("backend imported");\n');
    await writeFile(linkedTarget, 'process.stdout.write("backend imported");\n');
    await symlink(linkedTarget, linkedEntry, 'file');
    await writeFile(raceHook, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const originalStatSync = fs.statSync;',
      'let revoked = false;',
      'fs.statSync = function statThenRevoke(path, ...args) {',
      '  const result = originalStatSync(path, ...args);',
      '  if (!revoked && path === process.env.BACKEND_ENTRY) {',
      '    revoked = true;',
      '    fs.chmodSync(path, 0);',
      '  }',
      '  return result;',
      '};',
      'syncBuiltinESMExports();',
      '',
    ].join('\n'));

    for (const entry of [directEntry, linkedEntry]) {
      const result = spawnSync(process.execPath, ['--import', raceHook, launcher], {
        encoding: 'utf8',
        env: { ...process.env, BACKEND_ENTRY: entry },
      });

      expect(result.status).toBe(78);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(configurationError);
      expect(result.stderr).not.toContain(entry);
      expect(result.stderr).not.toContain(root);
      expect(result.stderr).not.toContain(process.cwd());
      expect(result.stderr).not.toMatch(/\b(?:EACCES|ERR_[A-Z_]+)\b/);
      expect(result.stderr).not.toContain('\n    at ');
    }
  });

  it('leaves genuine Backend startup failures outside the configuration boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strkworld-backend-startup-'));
    directories.push(root);
    const thrownEntry = join(root, 'throws.mjs');
    const missingDependencyEntry = join(root, 'missing-dependency.mjs');
    const unreadableDependencyEntry = join(root, 'unreadable-dependency-entry.mjs');
    const unreadableDependency = join(root, 'unreadable-dependency.mjs');
    const exactTupleEntry = join(root, 'exact-loader-tuple.mjs');
    const wrongSyscallEntry = join(root, 'wrong-syscall.mjs');
    const wrongCodeEntry = join(root, 'wrong-code.mjs');
    await writeFile(thrownEntry, 'throw new Error("backend startup marker");\n');
    await writeFile(missingDependencyEntry, 'await import("./absent-dependency.mjs");\n');
    await writeFile(unreadableDependencyEntry, 'await import("./unreadable-dependency.mjs");\n');
    await writeFile(unreadableDependency, 'export {};\n');
    await chmod(unreadableDependency, 0);
    const shapedFailure = (marker, code, syscall) => [
      "import { fileURLToPath } from 'node:url';",
      `throw Object.assign(new Error(${JSON.stringify(marker)}), {`,
      `  code: ${JSON.stringify(code)},`,
      `  syscall: ${JSON.stringify(syscall)},`,
      '  path: fileURLToPath(import.meta.url),',
      '});',
      '',
    ].join('\n');
    await writeFile(exactTupleEntry, shapedFailure('backend exact loader tuple marker', 'EACCES', 'open'));
    await writeFile(wrongSyscallEntry, shapedFailure('backend wrong syscall marker', 'EACCES', 'read'));
    await writeFile(wrongCodeEntry, shapedFailure('backend wrong code marker', 'EPERM', 'open'));

    for (const [entry, marker] of [
      [thrownEntry, 'backend startup marker'],
      [missingDependencyEntry, 'ERR_MODULE_NOT_FOUND'],
      [unreadableDependencyEntry, 'EACCES'],
      [exactTupleEntry, 'backend exact loader tuple marker'],
      [wrongSyscallEntry, 'backend wrong syscall marker'],
      [wrongCodeEntry, 'backend wrong code marker'],
    ]) {
      const result = spawnSync(process.execPath, [launcher], {
        encoding: 'utf8',
        env: { ...process.env, BACKEND_ENTRY: entry },
      });

      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(marker);
      expect(result.stderr).toContain('\n    at ');
      expect(result.stderr).not.toBe(configurationError);
    }
  });
});
