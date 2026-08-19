import { describe, expect, it } from 'vitest';
import { parseProductionLobbyEnvironment, startProductionLobby } from './production';

describe('production lobby configuration', () => {
  it('requires one or more real HTTPS browser origins', () => {
    expect(() => parseProductionLobbyEnvironment({})).toThrow('LOBBY_ALLOWED_ORIGINS');
    expect(() => parseProductionLobbyEnvironment({ LOBBY_ALLOWED_ORIGINS: 'http://localhost:5173' })).toThrow('LOBBY_ALLOWED_ORIGINS');
    expect(() => parseProductionLobbyEnvironment({ LOBBY_ALLOWED_ORIGINS: 'https://example.com/game' })).toThrow('LOBBY_ALLOWED_ORIGINS');
    expect(parseProductionLobbyEnvironment({ LOBBY_ALLOWED_ORIGINS: 'https://strkworld.example,https://www.strkworld.example', LOBBY_PORT: '18081' })).toEqual({
      hostname: '127.0.0.1',
      port: 18081,
      allowedOrigins: ['https://strkworld.example', 'https://www.strkworld.example'],
    });
  });

  it('binds the production entry only on loopback with the approved origin', async () => {
    const server = await startProductionLobby({
      LOBBY_PORT: String(45_000 + Math.floor(Math.random() * 1_000)),
      LOBBY_ALLOWED_ORIGINS: 'https://strkworld.example',
    });
    try {
      expect(server.endpoint).toContain('127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${server.port}/matchmake/joinOrCreate/street`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://strkworld.example' },
      });
      expect(response.headers.get('access-control-allow-origin')).toBe('https://strkworld.example');
    } finally {
      await server.shutdown();
    }
  });
});
