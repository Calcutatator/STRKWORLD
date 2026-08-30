import { createServer as createHttpServer, get as httpGet } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { describe, expect, it } from 'vitest';
import config, { createLocalBackendProxy, createViteConfig } from './vite.config';

describe('web environment lookup', () => {
  it('sets the repository root as the env directory named by the setup guide', async () => {
    const resolved = await config({
      command: 'serve',
      mode: 'development',
      isSsrBuild: false,
      isPreview: false,
    });

    expect(resolved).toMatchObject({ envDir: '../..' });
  });

  it('prebundles Phaser before the WorldHost lazy import can run', async () => {
    const resolved = await config({
      command: 'serve',
      mode: 'development',
      isSsrBuild: false,
      isPreview: false,
    });

    expect(resolved.optimizeDeps?.include).toContain('phaser');
  });
  it('does not configure a development backend proxy for production builds', async () => {
    const resolved = await config({
      command: 'build',
      mode: 'production',
      isSsrBuild: false,
      isPreview: false,
    });

    expect(resolved.server).toBeUndefined();
    expect(resolved.preview).toBeUndefined();
  });

  it('accepts only an explicitly configured loopback backend origin', () => {
    expect(createLocalBackendProxy(undefined)).toBeUndefined();
    expect(createLocalBackendProxy('https://backend.example')).toBeUndefined();
    expect(createLocalBackendProxy('http://192.168.1.10:8080')).toBeUndefined();
    expect(createLocalBackendProxy('http://127.0.0.1:8080')).toMatchObject({
      target: 'http://127.0.0.1:8080',
      changeOrigin: false,
    });
    expect(createLocalBackendProxy('http://[::1]:8080')).toMatchObject({
      target: 'http://[::1]:8080',
    });
  });

  it('keeps the browser same-origin while stripping only the local /api prefix', () => {
    const proxy = createLocalBackendProxy('http://localhost:8080');
    expect(proxy).toBeDefined();
    expect(proxy?.rewrite?.('/api/v1/private/fees')).toBe('/v1/private/fees');
    expect(proxy?.rewrite?.('/api')).toBe('/');
    expect(proxy?.rewrite?.('/api?x=1')).toBe('/?x=1');
    expect(proxy?.rewrite?.('/apis/private/fees')).toBe('/apis/private/fees');
  });

  it('adds the proxy only to the development server config', () => {
    const development = createViteConfig('serve', 'http://127.0.0.1:8080');
    const production = createViteConfig('build', 'http://127.0.0.1:8080');

    expect(development.server?.proxy).toHaveProperty('^/api(?:[/?]|$)');
    expect(production.server).toBeUndefined();
  });

  it('proxies the exact /api boundary without sending /apis to the backend', async () => {
    const received: string[] = [];
    const backend = createHttpServer((request, response) => {
      received.push(request.url ?? '');
      response.setHeader('connection', 'close');
      response.end('fake-backend');
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    const backendAddress = backend.address();
    if (!backendAddress || typeof backendAddress === 'string') throw new Error('Backend did not bind.');

    const development = createViteConfig(
      'serve',
      `http://127.0.0.1:${backendAddress.port}`,
    );
    const vite = await createViteServer({
      configFile: false,
      root: new URL('.', import.meta.url).pathname,
      logLevel: 'silent',
      // This test exercises only the HTTP proxy boundary. Disabling Vite's
      // dependency optimizer keeps its asynchronous scanner/esbuild lifecycle
      // out of the fixture, so teardown cannot race an unrelated optimization
      // job on repeated test runs.
      optimizeDeps: { disabled: true },
      server: {
        host: '127.0.0.1',
        port: 0,
        ...development.server,
      },
    });

    try {
      await vite.listen();
      const viteAddress = vite.httpServer?.address();
      if (!viteAddress || typeof viteAddress === 'string') throw new Error('Vite did not bind.');
      const origin = `http://127.0.0.1:${viteAddress.port}`;

      expect(await getText(`${origin}/api?x=1`)).toBe('fake-backend');
      expect(await getText(`${origin}/apis`)).not.toBe('fake-backend');
      expect(await getText(`${origin}/api2`)).not.toBe('fake-backend');
      expect(received).toEqual(['/?x=1']);
    } finally {
      await vite.close();
      await new Promise<void>((resolve, reject) => {
        backend.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 15_000);
});

function getText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve(body));
    });
    request.on('error', reject);
  });
}
