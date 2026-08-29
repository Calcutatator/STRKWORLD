import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeEdgeServer, createEdgeServer } from './edge';

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeEdgeServer(server, 20)));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return address.port;
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'strkworld-edge-'));
  directories.push(root);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<html>shell</html>');
  await writeFile(join(root, 'assets', 'app-abc123.js'), 'console.log(1);');
  return root;
}

async function fetchEdge(port: number, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

async function rawRequest(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function rawHttpRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.once('error', reject);
  });
}

describe('Fly edge public boundary', () => {
  it('serves assets and safely falls back to the SPA shell', async () => {
    const root = await fixture();
    const edge = createEdgeServer({ staticRoot: root, backendPort: 1, lobbyPort: 1, publicOrigin: 'https://game.example' });
    const port = await listen(edge);

    const asset = await fetchEdge(port, '/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');

    const route = await fetchEdge(port, '/city/bank');
    expect(route.status).toBe(200);
    expect(await route.text()).toBe('<html>shell</html>');
    expect(route.headers.get('cache-control')).toBe('no-cache');

    const traversal = await rawRequest(port, '/%2e%2e/%2e%2e/etc/passwd');
    expect(traversal.status).toBe(404);

    const health = await fetchEdge(port, '/health');
    expect(health.status).toBe(404);
    expect((await health.text()).toLowerCase()).not.toContain('healthy');

    const metrics = await fetchEdge(port, '/metrics');
    expect(metrics.status).toBe(404);
  });

  it('does not serve an SPA fallback that resolves outside the static root', async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'strkworld-edge-outside-'));
    directories.push(outside);
    await writeFile(join(outside, 'index.html'), '<html>outside</html>');
    await rm(join(root, 'index.html'));
    await symlink(join(outside, 'index.html'), join(root, 'index.html'));
    const edge = createEdgeServer({ staticRoot: root, backendPort: 1, lobbyPort: 1, publicOrigin: 'https://game.example' });
    const port = await listen(edge);

    const route = await fetchEdge(port, '/city/bank');
    expect(route.status).toBe(404);
    expect(await route.text()).not.toContain('outside');
  });

  it('proxies API and matchmaking paths without adding CORS', async () => {
    const root = await fixture();
    const upstream = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ path: request.url, method: request.method }));
    });
    const backendPort = await listen(upstream);
    const lobby = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.once('end', () => response.end(JSON.stringify({
        path: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      })));
    });
    const lobbyPort = await listen(lobby);
    const edge = createEdgeServer({ staticRoot: root, backendPort, lobbyPort, publicOrigin: 'https://game.example' });
    const edgePort = await listen(edge);

    const api = await fetchEdge(edgePort, '/api/v1/rpc/pool-config?x=1', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ path: '/v1/rpc/pool-config?x=1', method: 'POST' });
    expect(api.headers.get('access-control-allow-origin')).toBeNull();

    const matchmake = await fetchEdge(edgePort, '/matchmake/joinOrCreate/street', {
      method: 'POST',
      body: JSON.stringify({ x: 1, y: 2, facing: 'down', sprite: 'avatar-1' }),
      headers: {
        Origin: 'https://game.example',
        Cookie: 'session=private',
        Authorization: 'Bearer private',
        'Proxy-Authorization': 'Basic private',
        'X-Forwarded-For': '198.51.100.1',
      },
    });
    expect(matchmake.status).toBe(200);
    const matchmakeBody = await matchmake.json() as { path: string; headers: Record<string, string | undefined>; body: string };
    expect(matchmakeBody.path).toBe('/matchmake/joinOrCreate/street');
    expect(matchmakeBody.headers.origin).toBe('https://game.example');
    expect(matchmakeBody.headers.cookie).toBeUndefined();
    expect(matchmakeBody.headers.authorization).toBeUndefined();
    expect(matchmakeBody.headers['proxy-authorization']).toBeUndefined();
    expect(matchmakeBody.headers['x-forwarded-for']).toBeUndefined();
    expect(matchmakeBody.body).toBe('{"x":1,"y":2,"facing":"down","sprite":"avatar-1"}');
  });

  it.each([
    '/api/../health',
    '/api/%2e%2e/health',
    '/api/%2E%2E/health',
    '/api/%2fhealth',
    '/api/%5chealth',
    '/api//health',
    '/api/./health',
    '/api/v1;private/health',
    '/api/v1%3bprivate/health',
    '/api/v1/%zz',
  ])('rejects ambiguous API target %s before the private backend', async (target) => {
    const root = await fixture();
    let backendCalls = 0;
    const backend = createServer((_request, response) => {
      backendCalls += 1;
      response.end('private child');
    });
    const backendPort = await listen(backend);
    const edge = createEdgeServer({ staticRoot: root, backendPort, lobbyPort: 1, publicOrigin: 'https://game.example' });
    const edgePort = await listen(edge);

    const raw = await rawHttpRequest(
      edgePort,
      `POST ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`,
    );

    expect(raw).toContain('HTTP/1.1 400 Bad Request');
    expect(raw).not.toContain('private child');
    expect(backendCalls).toBe(0);
  });

  it.each([
    '/api',
    '/api/',
    '/api/v1/rpc/pool-config',
    '/api/v1/rpc/pool-config?x=1&y=%2E',
  ])('forwards canonical API target %s unchanged', async (target) => {
    const root = await fixture();
    let upstreamTarget = '';
    const backend = createServer((request, response) => {
      upstreamTarget = request.url ?? '';
      response.end('ok');
    });
    const backendPort = await listen(backend);
    const edge = createEdgeServer({ staticRoot: root, backendPort, lobbyPort: 1, publicOrigin: 'https://game.example' });
    const edgePort = await listen(edge);

    const raw = await rawHttpRequest(
      edgePort,
      `POST ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`,
    );

    expect(raw).toContain('HTTP/1.1 200 OK');
    expect(upstreamTarget).toBe(target.slice('/api'.length) || '/');
  });

  it('forwards the documented pool-config staging smoke without credentials', async () => {
    const root = await fixture();
    const backend = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.once('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          path: request.url,
          method: request.method,
          headers: request.headers,
          body: Buffer.concat(chunks).toString(),
        }));
      });
    });
    const backendPort = await listen(backend);
    const edge = createEdgeServer({ staticRoot: root, backendPort, lobbyPort: 1, publicOrigin: 'https://game.example' });
    const edgePort = await listen(edge);
    const body = '{"v":1}';

    const response = await fetchEdge(edgePort, '/api/v1/rpc/pool-config', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'session=private',
        Authorization: 'Bearer private',
        'Proxy-Authorization': 'Basic private',
        Forwarded: 'for=198.51.100.1',
        'X-Forwarded-For': '198.51.100.1',
        'X-Player-Identifier': 'private-player-id',
      },
    });

    expect(response.status).toBe(200);
    const received = await response.json() as {
      path: string;
      method: string;
      headers: Record<string, string | undefined>;
      body: string;
    };
    expect(received.path).toBe('/v1/rpc/pool-config');
    expect(received.method).toBe('POST');
    expect(received.body).toBe(body);
    expect(received.headers['content-type']).toBe('application/json');
    expect(received.headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(received.headers.cookie).toBeUndefined();
    expect(received.headers.authorization).toBeUndefined();
    expect(received.headers['proxy-authorization']).toBeUndefined();
    expect(received.headers.forwarded).toBeUndefined();
    expect(received.headers['x-forwarded-for']).toBeUndefined();
    expect(received.headers['x-player-identifier']).toBeUndefined();
  });

  it('forwards only JSON body metadata from the public API request', async () => {
    const root = await fixture();
    const backend = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.once('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          path: request.url,
          method: request.method,
          headers: request.headers,
          body: Buffer.concat(chunks).toString(),
        }));
      });
    });
    const backendPort = await listen(backend);
    const edge = createEdgeServer({ staticRoot: root, backendPort, lobbyPort: 1, publicOrigin: 'https://game.example' });
    const edgePort = await listen(edge);
    const body = JSON.stringify({ v: 1, route: 'transfer', feeAuthorization: 'body-bound-authorization' });

    const response = await fetchEdge(edgePort, '/api/v1/private/submit', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Cookie: 'session=private',
        Authorization: 'Bearer private',
        'Proxy-Authorization': 'Basic private',
        Forwarded: 'for=198.51.100.1',
        'X-Forwarded-For': '198.51.100.1',
        'X-Player-Identifier': 'private-player-id',
      },
    });

    expect(response.status).toBe(200);
    const received = await response.json() as {
      path: string;
      method: string;
      headers: Record<string, string | undefined>;
      body: string;
    };
    expect(received.path).toBe('/v1/private/submit');
    expect(received.method).toBe('POST');
    expect(received.body).toBe(body);
    expect(received.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(received.headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(received.headers.cookie).toBeUndefined();
    expect(received.headers.authorization).toBeUndefined();
    expect(received.headers['proxy-authorization']).toBeUndefined();
    expect(received.headers.forwarded).toBeUndefined();
    expect(received.headers['x-forwarded-for']).toBeUndefined();
    expect(received.headers['x-player-identifier']).toBeUndefined();
  });

  it.each([
    [
      'duplicate Content-Type',
      'Content-Type: application/json\r\nContent-Type: application/json\r\nContent-Length: 2',
    ],
    [
      'duplicate Content-Length',
      'Content-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2',
    ],
    [
      'missing Content-Type',
      'Content-Length: 2',
    ],
    [
      'malformed Content-Type',
      'Content-Type: application/json; charset\r\nContent-Length: 2',
    ],
    [
      'unsupported Content-Type',
      'Content-Type: text/plain\r\nContent-Length: 2',
    ],
    [
      'non-decimal Content-Length',
      'Content-Type: application/json\r\nContent-Length: 2.0',
    ],
  ])('rejects %s before the private backend', async (_label, metadata) => {
    const root = await fixture();
    let backendCalls = 0;
    const backend = createServer((_request, response) => {
      backendCalls += 1;
      response.end('unexpected');
    });
    const backendPort = await listen(backend);
    const edge = createEdgeServer({ staticRoot: root, backendPort, lobbyPort: 1, publicOrigin: 'https://game.example' });
    const edgePort = await listen(edge);

    const raw = await rawHttpRequest(
      edgePort,
      `POST /api/v1/private/submit HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${metadata}\r\n\r\n{}`,
    );
    const [, body = ''] = raw.split('\r\n\r\n', 2);

    expect(raw).toContain('HTTP/1.1 400 Bad Request');
    expect(body).toBe(JSON.stringify({ code: 'BAD_REQUEST', message: 'The request is invalid.' }));
    expect(backendCalls).toBe(0);
  });

  it.each(['avatar-9', 'avatar-16'])('admits and forwards only the D-047 placement fields for %s', async (sprite) => {
    const root = await fixture();
    const lobby = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.once('end', () => response.end(Buffer.concat(chunks).toString()));
    });
    const lobbyPort = await listen(lobby);
    const edge = createEdgeServer({ staticRoot: root, backendPort: 1, lobbyPort, publicOrigin: 'https://game.example' });
    const edgePort = await listen(edge);
    const placement = { x: 1, y: 2, facing: 'down', sprite };

    const response = await fetchEdge(edgePort, '/matchmake/joinOrCreate/street', {
      method: 'POST',
      body: JSON.stringify(placement),
      headers: { Origin: 'https://game.example' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(placement));
  });

  it('tunnels every websocket upgrade to the lobby', async () => {
    const root = await fixture();
    const lobby = createServer();
    lobby.on('upgrade', (request, socket) => {
      expect(request.url).toBe('/process_1/room_0001?sessionId=session_1');
      expect(request.headers.origin).toBe('https://game.example');
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers['proxy-authorization']).toBeUndefined();
      expect(request.headers['sec-websocket-protocol']).toBeUndefined();
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nready');
      socket.on('data', (chunk) => socket.write(chunk));
    });
    const lobbyPort = await listen(lobby);
    const edge = createEdgeServer({ staticRoot: root, backendPort: 1, lobbyPort, publicOrigin: 'https://game.example' });
    const edgePort = await listen(edge);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: edgePort });
      const chunks: Buffer[] = [];
      socket.once('connect', () => socket.write(
        'GET /process_1/room_0001?sessionId=session_1 HTTP/1.1\r\nHost: localhost\r\nOrigin: https://game.example\r\nCookie: session=private\r\nAuthorization: Bearer private\r\nProxy-Authorization: Basic private\r\nSec-WebSocket-Protocol: private\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      ));
      socket.on('data', (chunk) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        const value = Buffer.concat(chunks).toString();
        if (value.endsWith('ready')) {
          resolve(value.slice(value.indexOf('\r\n\r\n') + 4));
          socket.destroy();
        }
      });
      socket.on('error', reject);
    });
    expect(response).toBe('ready');
  });

  it('rejects missing and disallowed websocket origins before the lobby', async () => {
    const root = await fixture();
    const lobby = createServer();
    let upgrades = 0;
    lobby.on('upgrade', (_request, socket) => { upgrades += 1; socket.destroy(); });
    const lobbyPort = await listen(lobby);
    const edge = createEdgeServer({ staticRoot: root, backendPort: 1, lobbyPort, publicOrigin: 'https://game.example' });
    const edgePort = await listen(edge);

    for (const origin of [undefined, 'https://evil.example']) {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: edgePort });
        const headers = origin ? `Origin: ${origin}\r\n` : '';
        socket.once('connect', () => socket.write(
          `GET /anything HTTP/1.1\r\nHost: localhost\r\n${headers}Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        ));
        socket.once('data', (chunk) => { resolve(chunk.toString()); socket.destroy(); });
        socket.once('error', reject);
      });
      expect(response).toContain('403 Forbidden');
    }
    for (const path of [
      '/anything',
      '/process_1/room_0001',
      '/process_1/room_0001?sessionId=session_1&_authToken=secret',
      '/process_1/room_0001?sessionId=session_1&sessionId=session_2',
      '/process_1/room_0001?sessionId=secret%2Fvalue',
      '/process.1/room_0001?sessionId=session_1',
    ]) {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: edgePort });
        socket.once('connect', () => socket.write(
          `GET ${path} HTTP/1.1\r\nHost: localhost\r\nOrigin: https://game.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        ));
        socket.once('data', (chunk) => { resolve(chunk.toString()); socket.destroy(); });
        socket.once('error', reject);
      });
      expect(response).toContain('403 Forbidden');
    }
    expect(upgrades).toBe(0);
  });

  it('rejects non-contract matchmaking requests before the lobby sees them', async () => {
    const root = await fixture();
    let calls = 0;
    const lobby = createServer((request, response) => {
      calls += 1;
      request.resume();
      response.end('unexpected');
    });
    const lobbyPort = await listen(lobby);
    const edge = createEdgeServer({ staticRoot: root, backendPort: 1, lobbyPort, publicOrigin: 'https://game.example' });
    const edgePort = await listen(edge);
    const invalid = [
      ['/matchmake/joinOrCreate/street?x=1', 'POST', '{"x":1,"y":2,"facing":"down","sprite":"avatar-1"}'],
      ['/matchmake/join/street', 'POST', '{}'],
      ['/matchmake/joinOrCreate/street', 'GET', ''],
      ['/matchmake/joinOrCreate/street', 'POST', '{"x":1,"y":2,"facing":"down","sprite":"avatar-1","address":"secret"}'],
      ['/matchmake/joinOrCreate/street', 'POST', '[1,2,3]'],
      ['/matchmake/joinOrCreate/street', 'POST', '{"x":"1","y":2,"facing":"down","sprite":"avatar-1"}'],
      ['/matchmake/joinOrCreate/street', 'POST', '{"x":1,"y":2,"facing":"sideways","sprite":"avatar-1"}'],
      ['/matchmake/joinOrCreate/street', 'POST', '{"x":1,"y":2,"facing":"down","sprite":"avatar-17"}'],
      ['/matchmake/joinOrCreate/street', 'POST', '{"x":1,"y":2,"facing":"down","sprite":"avatar-1","stance":"fighting"}'],
      ['/matchmake/joinOrCreate/street', 'POST', '{"x":1,"y":2,"facing":"down","sprite":"x"'.padEnd(5000, 'x') + '}'],
    ] as const;
    for (const [path, method, body] of invalid) {
      const response = await fetchEdge(edgePort, path, {
        method,
        ...(method === 'GET' ? {} : { body }),
        headers: { Origin: 'https://game.example' },
      });
      expect([400, 404, 405, 413]).toContain(response.status);
    }
    expect(calls).toBe(0);
  });

  it('returns a generic failure when an upstream is unavailable', async () => {
    const root = await fixture();
    const edge = createEdgeServer({ staticRoot: root, backendPort: 1, lobbyPort: 1, publicOrigin: 'https://game.example' });
    const port = await listen(edge);
    const response = await fetchEdge(port, '/api/v1/rpc/pool-config', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: 'UPSTREAM_UNAVAILABLE', message: 'The service is temporarily unavailable.' });
  });
});
