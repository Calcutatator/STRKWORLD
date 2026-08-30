import { describe, expect, it, vi } from 'vitest';
import { Server } from '@colyseus/core';
import { startPresenceServer } from './server';

describe('presence server options', () => {
  it('rejects a non-finite port-attempt count before binding', async () => {
    await expect(
      startPresenceServer({ port: 0, portAttempts: Number.NaN }),
    ).rejects.toThrow('Lobby port attempts must be a positive safe integer.');
  });

  it('rejects a non-finite base port before binding', async () => {
    await expect(
      startPresenceServer({ port: Number.NaN }),
    ).rejects.toThrow('Lobby base port must be an integer from 0 through 65535.');
  });

  it('reports the ephemeral port when asked to bind port zero', async () => {
    const server = await startPresenceServer({ port: 0 });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(new URL(server.endpoint).port).toBe(String(server.port));
    } finally {
      await server.shutdown();
    }
  });

  it('rejects retry ranges that would exceed the TCP port ceiling before binding', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    listen.mockImplementation(async (port) => {
      if (port === 65_535) {
        throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
      }
      throw new Error(`invalid port ${port}`);
    });
    try {
      await expect(
        startPresenceServer({ hostname: '127.0.0.1', port: 65_535, portAttempts: 2 }),
      ).rejects.toThrow('Lobby port retry range exceeds 65535.');
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
  });
});
