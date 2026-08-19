import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPresenceServer, type PresenceServer } from './server';

let server: PresenceServer;

beforeAll(async () => {
  server = await startPresenceServer({
    hostname: '127.0.0.1',
    port: 45_000 + Math.floor(Math.random() * 2_000),
    portAttempts: 20,
  });
});

afterAll(async () => {
  await server.shutdown();
});

async function preflight(origin: string): Promise<Headers> {
  const response = await fetch(
    `http://127.0.0.1:${server.port}/matchmake/joinOrCreate/street`,
    {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    },
  );

  expect(response.ok).toBe(true);
  return response.headers;
}

describe('matchmaking CORS', () => {
  it('allows credentialed requests from the local web origin', async () => {
    const headers = await preflight('http://localhost:5173');

    expect(headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5173',
    );
    expect(headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does not grant credentials to an unapproved origin', async () => {
    const headers = await preflight('https://example.invalid');

    expect(headers.get('access-control-allow-origin')).toBeNull();
    expect(headers.get('access-control-allow-credentials')).toBeNull();
  });
});
