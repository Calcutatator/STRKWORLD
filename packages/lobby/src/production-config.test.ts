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

  it.each([
    'https://127.0.0.2',
    'https://127.1',
    'https://127.0.1',
    'https://2130706433',
    'https://0x7f000002',
    'https://017700000002',
    'https://[::1]',
    'https://[::ffff:127.0.0.2]',
    'https://[::ffff:7f00:2]',
    'https://localhost',
    'https://player.localhost',
    'https://nested.player.localhost',
    'https://example.invalid',
    'https://placeholder.example',
    'https://replace.example',
    'https://replace-host.example',
    'https://replace_host.example',
    'https://replace-this.example',
    'https://replace_this.example',
    'https://replace-me.example',
    'https://replace_me.example',
    'https://replace-with-host.example',
    'https://replace_with_hostname.example',
    'https://replace-with-me.example',
    'https://replace_with_me.example',
    'https://replacewithme.example',
    'https://replace.with.host.example',
    'https://REPLACE-WITH-HOST.example',
    'https://yourhost.example',
    'https://your_host.example',
    'https://your-host.example',
    'https://yourhostname.example',
    'https://your_hostname.example',
    'https://yourdomain.example',
    'https://your-domain.example',
    'https://your.host.example',
  ])('rejects non-production origin %s with a generic error that does not echo it', (origin) => {
    let thrown: unknown;
    try {
      parseProductionLobbyEnvironment({ LOBBY_ALLOWED_ORIGINS: origin });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toBe('Invalid LOBBY_ALLOWED_ORIGINS.');
    expect(message).not.toContain(origin);
  });

  it.each([
    'https://your-company.com',
    'https://replaceable.example.com',
    'https://placeholdertech.com',
  ])('preserves legitimate public origin %s', (origin) => {
    expect(parseProductionLobbyEnvironment({
      LOBBY_ALLOWED_ORIGINS: origin,
      LOBBY_PORT: '18081',
    })).toEqual({
      hostname: '127.0.0.1',
      port: 18081,
      allowedOrigins: [origin],
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
