import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type UserConfig } from 'vite';

const REPOSITORY_ROOT = new URL('../../', import.meta.url);
const LOCAL_API_PROXY_CONTEXT = '^/api(?:[/?]|$)';

/**
 * Resolve the development-only same-origin API proxy.
 *
 * The browser always calls `/api`. A local backend is opt-in through the
 * non-VITE `STRKWORLD_DEV_BACKEND_ORIGIN` variable so its origin is never
 * compiled into the public bundle. Refusing anything except an explicit
 * HTTP loopback origin keeps this convenience from becoming an accidental
 * cross-origin credential or privacy boundary.
 */
export function createLocalBackendProxy(origin: string | undefined) {
  if (!origin) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return undefined;
  }

  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !isLoopbackHost(parsed.hostname)
  ) {
    return undefined;
  }

  return {
    target: parsed.origin,
    changeOrigin: false,
    rewrite: (path: string) => {
      const rewritten = path.replace(/^\/api(?=\/|\?|$)/, '');
      if (rewritten === '') return '/';
      return rewritten.startsWith('?') ? `/${rewritten}` : rewritten;
    },
  };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet))) return false;
  const values = octets.map(Number);
  return values[0] === 127 && values.every((value) => value >= 0 && value <= 255);
}

export function createViteConfig(command: 'serve' | 'build', backendOrigin?: string): UserConfig {
  const localProxy = command === 'serve' ? createLocalBackendProxy(backendOrigin) : undefined;

  return {
    // The committed template and setup guide live at the workspace root. Vite's
    // workspace script otherwise searches from apps/web and silently misses
    // the copied root .env.local file.
    envDir: '../..',
    plugins: [react()],
    // WorldHost loads Phaser through a lazy runtime boundary. Prebundling the
    // large dependency at dev-server startup prevents Vite's on-demand
    // optimizer from invalidating that boundary after the browser has already
    // received its module URL (which otherwise leaves the WorldHost empty with
    // a 504 Outdated Optimize Dep response).
    optimizeDeps: {
      include: ['phaser'],
    },
    ...(localProxy ? { server: { proxy: { [LOCAL_API_PROXY_CONTEXT]: localProxy } } } : {}),
  };
}

/**
 * Build config for the shell.
 *
 * Only the React plugin and an opt-in loopback dev proxy live here. This file
 * carries no site-wide header policy. Cross-origin isolation breaks wallet
 * `postMessage` popups and iframes; the separate header gate owns that rule.
 *
 * Phaser is pulled in through a dynamic import in the world runtime, so it
 * lands in its own lazy chunk rather than the entry chunk — Phaser 4 does not
 * tree-shake, and a single eager import would ship the whole engine up front.
 */
export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, REPOSITORY_ROOT.pathname, '');
  return createViteConfig(command, environment.STRKWORLD_DEV_BACKEND_ORIGIN);
});
