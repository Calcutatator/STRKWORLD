import { describe, expect, it } from 'vitest';
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
});
