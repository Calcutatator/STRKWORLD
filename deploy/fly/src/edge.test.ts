import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

describe('Fly edge public boundary', () => {
  it('serves assets and safely falls back to the SPA shell', async () => {
    const root = await fixture();
    const edge = createEdgeServer({ staticRoot: root, backendPort: 1, lobbyPort: 1 });
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
  });

  it('proxies API and matchmaking paths without adding CORS', async () => {
    const root = await fixture();
    const upstream = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ path: request.url, method: request.method }));
    });
    const backendPort = await listen(upstream);
    const lobby = createServer((request, response) => {
      response.end(JSON.stringify({ path: request.url }));
    });
    const lobbyPort = await listen(lobby);
    const edge = createEdgeServer({ staticRoot: root, backendPort, lobbyPort });
    const edgePort = await listen(edge);

    const api = await fetchEdge(edgePort, '/api/v1/rpc/pool-config?x=1', { method: 'POST' });
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ path: '/v1/rpc/pool-config?x=1', method: 'POST' });
    expect(api.headers.get('access-control-allow-origin')).toBeNull();

    const matchmake = await fetchEdge(edgePort, '/matchmake/joinOrCreate/street', { method: 'POST' });
    expect(matchmake.status).toBe(200);
    expect(await matchmake.json()).toEqual({ path: '/matchmake/joinOrCreate/street' });
  });

  it('tunnels every websocket upgrade to the lobby', async () => {
    const root = await fixture();
    const lobby = createServer();
    lobby.on('upgrade', (request, socket) => {
      expect(request.url).toBe('/anything');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nready');
      socket.on('data', (chunk) => socket.write(chunk));
    });
    const lobbyPort = await listen(lobby);
    const edge = createEdgeServer({ staticRoot: root, backendPort: 1, lobbyPort });
    const edgePort = await listen(edge);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: edgePort });
      const chunks: Buffer[] = [];
      socket.once('connect', () => socket.write(
        'GET /anything HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\r\n',
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

  it('returns a generic failure when an upstream is unavailable', async () => {
    const root = await fixture();
    const edge = createEdgeServer({ staticRoot: root, backendPort: 1, lobbyPort: 1 });
    const port = await listen(edge);
    const response = await fetchEdge(port, '/api/v1/rpc/pool-config', { method: 'POST' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: 'UPSTREAM_UNAVAILABLE', message: 'The service is temporarily unavailable.' });
  });
});
