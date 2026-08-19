import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { realpath, readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

export interface EdgeOptions {
  readonly staticRoot: string;
  readonly backendPort: number;
  readonly lobbyPort: number;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const activeSockets = new WeakMap<Server, Set<Socket>>();

export function createEdgeServer(options: EdgeOptions): Server {
  const root = resolve(options.staticRoot);
  const server = createServer((request, response) => {
    void handleRequest(request, response, { ...options, staticRoot: root });
  }).on('upgrade', (request, socket, head) => {
    tunnelUpgrade(request, socket, head, options.lobbyPort);
  });
  const sockets = new Set<Socket>();
  activeSockets.set(server, sockets);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return server;
}

/** Close the public edge, bounding upgraded WebSocket connections as well. */
export function closeEdgeServer(server: Server, timeoutMs = 5_000): Promise<void> {
  const sockets = activeSockets.get(server);
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      sockets?.forEach((socket) => socket.destroy());
      finish();
    }, timeoutMs);
    server.close((error) => finish(error ?? undefined));
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: EdgeOptions,
): Promise<void> {
  const method = request.method ?? 'GET';
  const pathname = pathnameOf(request.url);
  if (pathname === null) return sendError(response, 400, 'BAD_REQUEST', 'The request is invalid.');

  if (pathname === '/health' || pathname === '/healthz' || pathname === '/metrics') {
    return sendError(response, 404, 'NOT_FOUND', 'The requested resource was not found.');
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return proxyHttp(request, response, options.backendPort, stripApiPrefix(request.url ?? '/'));
  }
  if (pathname === '/matchmake' || pathname.startsWith('/matchmake/')) {
    return proxyHttp(request, response, options.lobbyPort, request.url ?? '/');
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return sendError(response, 405, 'METHOD_NOT_ALLOWED', 'The method is not allowed.');
  }
  return serveStatic(request, response, options.staticRoot, pathname);
}

function pathnameOf(url: string | undefined): string | null {
  const rawPath = (url ?? '/').split('?', 1)[0] ?? '/';
  return rawPath.startsWith('/') && !rawPath.includes('#') ? rawPath : null;
}

function stripApiPrefix(url: string): string {
  const suffix = url.slice('/api'.length);
  return suffix === '' ? '/' : suffix;
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  pathname: string,
): Promise<void> {
  const relativePath = safeRelativePath(pathname);
  if (relativePath === null) return sendError(response, 404, 'NOT_FOUND', 'The requested resource was not found.');

  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return sendError(response, 404, 'NOT_FOUND', 'The requested resource was not found.');

  let file = resolve(rootReal, relativePath);
  let cacheControl = 'no-cache';
  const candidate = await safeFile(file, rootReal);
  if (!candidate) {
    // A path with an extension is an asset request, not a client-side route.
    if (extname(relativePath) !== '') {
      return sendError(response, 404, 'NOT_FOUND', 'The requested resource was not found.');
    }
    file = resolve(rootReal, 'index.html');
  } else {
    file = candidate;
    if (relativePath.startsWith(`assets${sep}`)) {
      cacheControl = 'public, max-age=31536000, immutable';
    }
  }

  const content = await readFile(file).catch(() => null);
  if (content === null) return sendError(response, 404, 'NOT_FOUND', 'The requested resource was not found.');
  response.statusCode = 200;
  response.setHeader('cache-control', cacheControl);
  response.setHeader('content-type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
  response.setHeader('content-length', content.byteLength);
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(request.method === 'HEAD' ? undefined : content);
}

function safeRelativePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || !decoded.startsWith('/')) return null;
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '..')) return null;
  return segments.filter(Boolean).join(sep);
}

async function safeFile(file: string, root: string): Promise<string | null> {
  const resolved = await realpath(file).catch(() => null);
  if (!resolved) return null;
  const within = resolved === root || resolved.startsWith(`${root}${sep}`);
  if (!within || !(await stat(resolved).then((entry) => entry.isFile()).catch(() => false))) return null;
  return resolved;
}

function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  path: string,
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
  }
  const upstream = httpRequest(
    { hostname: '127.0.0.1', port, method: request.method, path, headers },
    (upstreamResponse) => {
      response.statusCode = upstreamResponse.statusCode ?? 502;
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name)) response.setHeader(name, value);
      }
      upstreamResponse.pipe(response);
    },
  );
  upstream.once('error', () => {
    if (!response.headersSent) sendError(response, 502, 'UPSTREAM_UNAVAILABLE', 'The service is temporarily unavailable.');
    else response.destroy();
  });
  request.once('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

function tunnelUpgrade(
  request: IncomingMessage,
  client: import('node:stream').Duplex,
  head: Buffer,
  port: number,
): void {
  const upstream = createConnection({ host: '127.0.0.1', port });
  let connected = false;
  upstream.once('connect', () => {
    connected = true;
    const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`];
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) lines.push(`${name}: ${item}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.once('error', () => {
    if (!connected && !client.destroyed) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else {
      client.destroy();
    }
  });
  client.once('error', () => upstream.destroy());
  client.once('close', () => upstream.destroy());
  upstream.once('close', () => client.destroy());
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ code, message });
  response.statusCode = status;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(body);
}

export async function waitForTcp(
  port: number,
  options: { host?: string; timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await connectOnce(host, port);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error('Child service did not become ready.');
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

function connectOnce(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}
