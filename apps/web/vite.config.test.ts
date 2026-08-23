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
    expect(proxy?.rewrite?.('/apis/private/fees')).toBe('/apis/private/fees');
  });

  it('adds the proxy only to the development server config', () => {
    const development = createViteConfig('serve', 'http://127.0.0.1:8080');
    const production = createViteConfig('build', 'http://127.0.0.1:8080');

    expect(development.server?.proxy).toHaveProperty('/api');
    expect(production.server).toBeUndefined();
  });
});
