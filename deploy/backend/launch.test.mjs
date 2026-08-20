import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
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
});
