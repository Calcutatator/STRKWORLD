import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isLoopbackHostname, validateLobbyBuildValue, validateStaticArtifact } from '../check-static.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Fly static build gate', () => {
  it('packages the compiled shared workspace into the runtime image', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('COPY --from=build --chown=node:node /repo/.fly-build/packages/shared ./node_modules/@strkworld/shared');
    expect(dockerfile).toContain('"main":"./src/index.js"');
    expect(dockerfile).toContain('RUN rm -f node_modules/@strkworld/shared');
  });

  it('accepts only a real wss origin', () => {
    const rejected = [
      'https://example.com',
      'ws://example.com',
      'wss://user:pass@example.com',
      'wss://example.com/game',
      'wss://example.com?query=1',
      'wss://example.com#hash',
      'WSS://example.com',
      'wss://EXAMPLE.com',
      'wss://example.com/',
      'wss://localhost',
      'wss://localhost.',
      'wss://play.localhost',
      'wss://127.0.0.1',
      'wss://127.0.0.0',
      'wss://127.0.0.2',
      'wss://127.128.0.1',
      'wss://127.255.255.254:443',
      'wss://[::1]',
      'wss://[0:0:0:0:0:0:0:1]',
      'wss://[0:0:0:0:0:0:0:01]',
      'wss://[::ffff:127.0.0.2]',
      'wss://[::ffff:7f00:2]',
      'wss://invalid',
      'wss://example.invalid',
      'wss://REPLACE-WITH-LOBBY-HOST',
      'wss://placeholder.example.com',
      'wss://your-domain.example.com',
    ];
    for (const value of rejected) expect(() => validateLobbyBuildValue(value), value).toThrow();
    expect(() => validateLobbyBuildValue('wss://example.com')).not.toThrow();
    expect(() => validateLobbyBuildValue('wss://presence.example.com:8443')).not.toThrow();
    expect(isLoopbackHostname('127.0.0.2')).toBe(true);
    expect(isLoopbackHostname('[::ffff:7f00:2]')).toBe(true);
  });

  it('requires the configured endpoint and rejects app localhost URLs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strkworld-static-check-'));
    directories.push(root);
    await writeFile(join(root, 'index.html'), '<script src="app.js"></script>');
    await writeFile(join(root, 'app.js'), 'const lobby = "wss://example.com"; const sdk = "ws://127.0.0.1:2567";');
    await expect(validateStaticArtifact(root, 'wss://example.com')).resolves.toBeUndefined();
    await writeFile(join(root, 'app.js'), 'const lobby = "ws://127.0.0.2:2567";');
    await expect(validateStaticArtifact(root, 'wss://example.com')).rejects.toThrow();
  });

  it('allows only the pinned unreachable SDK fallback and never mutates artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strkworld-static-check-'));
    directories.push(root);
    const source = 'const lobby = "wss://example.com"; const sdk = "ws://127.0.0.1:2567";';
    await writeFile(join(root, 'app.js'), source);
    await writeFile(join(root, 'font.bin'), Buffer.from('ws://127.0.0.2:2567'));
    await expect(validateStaticArtifact(root, 'wss://example.com')).resolves.toBeUndefined();
    const { readFile } = await import('node:fs/promises');
    await expect(readFile(join(root, 'app.js'), 'utf8')).resolves.toBe(source);
  });
});
