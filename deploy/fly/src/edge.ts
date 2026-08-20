import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { realpath, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { resolveContainedRegularFile } from './static-file.js';

export interface EdgeOptions {
  readonly staticRoot: string;
  readonly backendPort: number;
  readonly lobbyPort: number;
  /** The only browser origin allowed to upgrade the lobby WebSocket. */
  readonly publicOrigin: string;
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
    tunnelUpgrade(request, socket, head, options.lobbyPort, options.publicOrigin);
  }).on('clientError', (_error, socket) => {
    sendRawBadRequest(socket);
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
    const headers = apiHeaders(request);
    if (headers === null) {
      request.resume();
      return sendError(response, 400, 'BAD_REQUEST', 'The request is invalid.');
    }
    return proxyHttp(request, response, options.backendPort, stripApiPrefix(request.url ?? '/'), {
      headers,
    });
  }
  if (pathname === '/matchmake' || pathname.startsWith('/matchmake/')) {
    return handleMatchmake(request, response, options);
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

function apiHeaders(request: IncomingMessage): Record<string, string> | null {
  const headers: Record<string, string> = {};
  const contentTypes = rawHeaderValues(request, 'content-type');
  if (contentTypes.length > 1) return null;
  const contentType = contentTypes[0];
  if (request.method === 'POST' && contentType === undefined) return null;
  if (contentType !== undefined) {
    if (!isJsonContentType(contentType)) return null;
    headers['content-type'] = contentType;
  }

  const contentLengths = rawHeaderValues(request, 'content-length');
  if (contentLengths.length > 1) return null;
  const contentLength = contentLengths[0];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength))) return null;
    headers['content-length'] = contentLength;
  }
  return headers;
}

function rawHeaderValues(request: IncomingMessage, expectedName: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === expectedName) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

function isJsonContentType(value: string): boolean {
  const separator = value.indexOf(';');
  const mediaType = (separator < 0 ? value : value.slice(0, separator)).trim();
  if (mediaType !== 'application/json') return false;
  if (separator < 0) return true;

  let index = separator;
  while (index < value.length) {
    if (value[index] !== ';') return false;
    index += 1;
    index = skipOptionalWhitespace(value, index);

    const nameStart = index;
    while (index < value.length && isHttpTokenCharacter(value[index]!)) index += 1;
    if (index === nameStart) return false;
    index = skipOptionalWhitespace(value, index);
    if (value[index] !== '=') return false;
    index += 1;
    index = skipOptionalWhitespace(value, index);

    if (value[index] === '"') {
      index += 1;
      let closed = false;
      while (index < value.length) {
        const character = value[index]!;
        if (character === '"') {
          index += 1;
          closed = true;
          break;
        }
        if (character === '\\') {
          index += 1;
          if (index >= value.length || !isVisibleHeaderCharacter(value[index]!)) return false;
          index += 1;
          continue;
        }
        if (!isQuotedHeaderCharacter(character)) return false;
        index += 1;
      }
      if (!closed) return false;
    } else {
      const valueStart = index;
      while (index < value.length && isHttpTokenCharacter(value[index]!)) index += 1;
      if (index === valueStart) return false;
    }

    index = skipOptionalWhitespace(value, index);
  }
  return true;
}

function skipOptionalWhitespace(value: string, start: number): number {
  let index = start;
  while (value[index] === ' ' || value[index] === '\t') index += 1;
  return index;
}

function isHttpTokenCharacter(character: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/.test(character);
}

function isVisibleHeaderCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return character === '\t' || (code >= 0x20 && code <= 0x7e);
}

function isQuotedHeaderCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return character === '\t' || code === 0x20 || code === 0x21 ||
    (code >= 0x23 && code <= 0x5b) || (code >= 0x5d && code <= 0x7e);
}

const MATCHMAKE_PATH = '/matchmake/joinOrCreate/street';
const MAX_MATCHMAKE_BODY_BYTES = 4096;
const ID_PATTERN = /^[A-Za-z0-9_-]{9}$/;
const FACING = new Set(['up', 'down', 'left', 'right']);
const SPRITES = new Set([
  'avatar-1',
  'avatar-2',
  'avatar-3',
  'avatar-4',
  'avatar-5',
  'avatar-6',
  'avatar-7',
  'avatar-8',
  'avatar-9',
  'avatar-10',
  'avatar-11',
  'avatar-12',
  'avatar-13',
  'avatar-14',
  'avatar-15',
  'avatar-16',
]);

async function handleMatchmake(
  request: IncomingMessage,
  response: ServerResponse,
  options: EdgeOptions,
): Promise<void> {
  const target = request.url ?? '/';
  const queryStart = target.indexOf('?');
  const pathname = queryStart < 0 ? target : target.slice(0, queryStart);
  if (pathname !== MATCHMAKE_PATH || queryStart >= 0) {
    return sendError(response, 404, 'NOT_FOUND', 'The requested resource was not found.');
  }
  if (request.method === 'OPTIONS') {
    return proxyHttp(request, response, options.lobbyPort, MATCHMAKE_PATH, {
      body: Buffer.alloc(0),
      headers: lobbyHeaders(request, options.publicOrigin, true),
    });
  }
  if (request.method !== 'POST') {
    return sendError(response, 405, 'METHOD_NOT_ALLOWED', 'The method is not allowed.');
  }

  let body: Buffer;
  try {
    body = await readLimitedBody(request, MAX_MATCHMAKE_BODY_BYTES);
  } catch (error) {
    return sendError(response, error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 400, 'BAD_REQUEST', 'The request is invalid.');
  }
  const placement = parsePlacement(body);
  if (!placement) return sendError(response, 400, 'BAD_REQUEST', 'The request is invalid.');
  const sanitized = Buffer.from(JSON.stringify(placement));
  return proxyHttp(request, response, options.lobbyPort, MATCHMAKE_PATH, {
    body: sanitized,
    headers: lobbyHeaders(request, options.publicOrigin, false),
  });
}

function lobbyHeaders(request: IncomingMessage, publicOrigin: string, preflight: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin === publicOrigin) headers.origin = origin;
  if (!preflight) {
    headers.accept = 'application/json';
    headers['content-type'] = 'application/json';
  }
  return headers;
}

function readLimitedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > maximum) {
    request.resume();
    return Promise.reject(new Error('BODY_TOO_LARGE'));
  }
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      request.resume();
      reject(error);
    };
    request.on('data', (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += next.byteLength;
      if (length > maximum) return fail(new Error('BODY_TOO_LARGE'));
      chunks.push(next);
    });
    request.once('error', (error) => fail(error instanceof Error ? error : new Error('BODY_READ_FAILED')));
    request.once('end', () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks));
    });
  });
}

function parsePlacement(body: Buffer): { x: number; y: number; facing: string; sprite: string } | null {
  let value: unknown;
  try { value = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'facing,sprite,x,y') return null;
  const placement = value as Record<string, unknown>;
  if (
    typeof placement.x !== 'number' || !Number.isSafeInteger(placement.x) || Math.abs(placement.x) > 8192 ||
    typeof placement.y !== 'number' || !Number.isSafeInteger(placement.y) || Math.abs(placement.y) > 8192 ||
    typeof placement.facing !== 'string' || !FACING.has(placement.facing) ||
    typeof placement.sprite !== 'string' || !SPRITES.has(placement.sprite)
  ) return null;
  return { x: placement.x, y: placement.y, facing: placement.facing, sprite: placement.sprite };
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
  const candidate = await resolveContainedRegularFile(file, rootReal);
  if (!candidate) {
    // A path with an extension is an asset request, not a client-side route.
    if (extname(relativePath) !== '') {
      return sendError(response, 404, 'NOT_FOUND', 'The requested resource was not found.');
    }
    const fallback = await resolveContainedRegularFile(resolve(rootReal, 'index.html'), rootReal);
    if (!fallback) return sendError(response, 404, 'NOT_FOUND', 'The requested resource was not found.');
    file = fallback;
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

function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  path: string,
  options: { readonly headers?: Record<string, string>; readonly body?: Buffer } = {},
): void {
  const headers: Record<string, string | string[]> = options.headers ?? {};
  if (!options.headers) for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
  }
  if (options.body !== undefined) headers['content-length'] = String(options.body.byteLength);
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
  if (options.body !== undefined) upstream.end(options.body);
  else request.pipe(upstream);
}

function tunnelUpgrade(
  request: IncomingMessage,
  client: import('node:stream').Duplex,
  head: Buffer,
  port: number,
  publicOrigin: string,
): void {
  const key = request.headers['sec-websocket-key'];
  const target = request.headers.origin === publicOrigin
    ? parseWebSocketTarget(request.url)
    : null;
  if (request.method !== 'GET' || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !isWebSocketKey(key) || !target) {
    client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const upstream = createConnection({ host: '127.0.0.1', port });
  let connected = false;
  upstream.once('connect', () => {
    connected = true;
    const lines = [`GET ${target} HTTP/${request.httpVersion}`];
    lines.push('Host: 127.0.0.1');
    lines.push('Connection: Upgrade');
    lines.push('Upgrade: websocket');
    lines.push(`Origin: ${publicOrigin}`);
    lines.push(`Sec-WebSocket-Key: ${key}`);
    lines.push('Sec-WebSocket-Version: 13');
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

function isWebSocketKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) return false;
  return Buffer.from(value, 'base64').byteLength === 16;
}

function parseWebSocketTarget(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let parsed: URL;
  try { parsed = new URL(`ws://edge${raw}`); } catch { return null; }
  if (parsed.hash || parsed.origin !== 'ws://edge' || parsed.searchParams.size !== 1 || !parsed.searchParams.has('sessionId')) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  const sessionId = parsed.searchParams.get('sessionId');
  if (segments.length !== 2 || segments.some((segment) => !ID_PATTERN.test(segment)) || !sessionId || !ID_PATTERN.test(sessionId)) return null;
  if (parsed.searchParams.keys().next().value !== 'sessionId') return null;
  if (parsed.searchParams.getAll('sessionId').length !== 1 || parsed.searchParams.has('_authToken') || parsed.searchParams.has('reconnectionToken')) return null;
  return `/${segments[0]}/${segments[1]}?sessionId=${encodeURIComponent(sessionId)}`;
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

function sendRawBadRequest(socket: import('node:stream').Duplex): void {
  if (socket.destroyed || !socket.writable) return;
  const body = JSON.stringify({ code: 'BAD_REQUEST', message: 'The request is invalid.' });
  socket.end([
    'HTTP/1.1 400 Bad Request',
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'X-Content-Type-Options: nosniff',
    '',
    body,
  ].join('\r\n'));
}
