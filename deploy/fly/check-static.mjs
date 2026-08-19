import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { extname, join, resolve } from 'node:path';

const TEXT_EXTENSIONS = new Set(['.html', '.js', '.css', '.map']);
const DEV_LOBBY_FALLBACK = 'ws://127.0.0.1:2567';
const WEBSOCKET_LITERAL = /\bws(?:s)?:\/\/[^\s"'`<>]+/gi;

/** Return whether a host is a loopback address or localhost name. */
export function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const ipVersion = isIP(host.replace(/^\[|\]$/g, ''));
  if (ipVersion === 4) {
    const octets = host.split('.').map(Number);
    return octets.length === 4 && octets[0] === 127;
  }
  if (ipVersion !== 6) return false;

  const words = parseIPv6(host);
  if (!words) return false;
  if (words.every((word, index) => index === 7 ? word === 1 : word === 0)) return true;
  // IPv4-mapped loopback is still loopback, even when written as IPv6.
  return words.slice(0, 5).every((word) => word === 0)
    && words[5] === 0xffff
    && (words[6] >> 8) === 127;
}

function parseIPv6(host) {
  const value = host.replace(/^\[|\]$/g, '');
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const parseWords = (parts) => {
    const words = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        words.push(Number.parseInt(part, 16));
      } else {
        return null;
      }
    }
    return words;
  };
  const leftWords = parseWords(left);
  const rightWords = parseWords(right);
  if (!leftWords || !rightWords) return null;
  if (halves.length === 1) return leftWords.length === 8 ? leftWords : null;
  if (leftWords.length + rightWords.length >= 8) return null;
  return [...leftWords, ...Array(8 - leftWords.length - rightWords.length).fill(0), ...rightWords];
}

/** Testable production build-argument validator. */
export function isRealWssOrigin(value) {
  if (typeof value !== 'string' || value.trim() !== value || value === '') return false;
  // URL canonicalizes the scheme and hostname; require the caller's spelling
  // to be canonical too, so uppercase/noncanonical origins cannot slip past
  // the origin comparison below.
  if (!value.startsWith('wss://')) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  const bareHost = host.replace(/\.+$/, '');
  return (
    parsed.protocol === 'wss:'
    && parsed.origin === value
    && parsed.username === ''
    && parsed.password === ''
    && parsed.pathname === '/'
    && parsed.search === ''
    && parsed.hash === ''
    && !isLoopbackHostname(host)
    && bareHost !== 'invalid'
    && !bareHost.endsWith('.invalid')
    && !/(?:PLACEHOLDER|REPLACE|YOUR(?:[-_ ]|$))/i.test(bareHost)
  );
}

export function validateLobbyBuildValue(value) {
  if (!isRealWssOrigin(value)) throw new Error('VITE_LOBBY_URL must be a real HTTPS WebSocket origin.');
}

async function collect(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, files);
    else if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path);
  }
}

export async function validateStaticArtifact(root, expected) {
  validateLobbyBuildValue(expected);
  const files = [];
  await collect(root, files);
  const text = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
  if (!text.includes(expected)) throw new Error('The configured lobby endpoint is absent from the web artifact.');
  // The pinned @colyseus/sdk contains this unreachable development fallback.
  // It is the only loopback websocket literal allowed in the bundle; the scan
  // never writes or rewrites the vendor/application artifact.
  for (const literal of text.match(WEBSOCKET_LITERAL) ?? []) {
    const candidate = literal.replace(/[),.;]+$/, '');
    if (candidate === DEV_LOBBY_FALLBACK) continue;
    let parsed;
    try { parsed = new URL(candidate); } catch { continue; }
    if (isLoopbackHostname(parsed.hostname)) throw new Error('A localhost lobby endpoint reached the web artifact.');
  }
}

const modulePath = resolve(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === modulePath) {
  const args = process.argv.slice(2);
  if (args[0] === '--validate-only') validateLobbyBuildValue(args[1]);
  else await validateStaticArtifact(args[0], args[1]);
}
