import type { EventBus, WorldEvents } from '@strkworld/shared';
import {
  ownBuildingPayload,
  ownLockedBuildingPayload,
  ownStationPayload,
} from '../bus/world-event-payload.js';
import { createViewerStorage, type ViewerStorage } from '../store/viewer-storage.js';
import {
  cleanText,
  describeApiFailure,
  describeBankStep,
  describeConnectState,
  describeFailure,
  describeGateState,
  describeLeaderboardStep,
  describePlazaShells,
  describeSandboxTile,
  describeValue,
  describeVaultStep,
  describeWalletSession,
  describeFootball,
  eventName,
  failureLevel,
  plazaPanel,
  visitPanel,
  type DebugLevel,
} from './debug-format.js';
import { attachDebugTap } from './debug-tap.js';

/**
 * Opt-in remote debug logs for a test deployment (D-069).
 *
 * Two gates, both required. The build must be compiled with
 * `VITE_DEBUG_LOGS=true` (`main.tsx` imports this module only then, so a launch
 * build never contains it), and the page must be opened with `?debug=1`, which
 * is remembered for this browser session; `?debug=0` or the badge's button
 * turns it off. While it is on, a badge says so.
 *
 * It captures window errors and unhandled rejections, `console.error` and
 * `console.warn` (which still print), every privacy and wallet failure the
 * Shell funnels (`debug-tap.ts`), connect-flow states, wallet-session
 * snapshots, building and station events, panel opens and closes, the Bank's
 * mode switches, refused adds, prepares and confirm stages (codes and intent
 * kinds only, D-070), sandbox bursts (the tile only, D-071), the entry gate's
 * transitions (state names only, D-072), the private placement's probe switch,
 * receipts and DeFi ticks (reason codes only, D-122), and failed `/api`
 * responses (path, status and body code only). Entries go to the
 * backend's `/api/v1/debug/logs` every 3 s, and by `sendBeacon` when the page
 * is hidden for good. The session id is random for this browser session:
 * never the lobby id, never derived from the wallet.
 */

export const DEBUG_LOGS_URL = '/api/v1/debug/logs';
export const DEBUG_FLUSH_MS = 3_000;
/** The server's limits: 50 entries and 32 KB of compact JSON a batch. */
export const MAX_BATCH_ENTRIES = 50;
export const MAX_BATCH_BYTES = 32 * 1024;
/** Entries held between flushes; past this they are counted, not kept. */
export const MAX_BUFFERED_ENTRIES = 200;
/** Batches sent by beacon on the way out: the browser allows 64 KB in flight. */
const BEACON_BATCHES = 2;
/** A batch still unanswered by then is abandoned, so a stuck request cannot stall the next. */
const POST_TIMEOUT_MS = 10_000;
export const OPT_IN_KEY = 'strkworld:debug-logs';
export const SESSION_KEY = 'strkworld:debug-session';
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Tester-facing copy. It lives here rather than in `copy.ts` so that a launch
 * build, which never loads this module, carries none of it.
 */
export const DEBUG_COPY = Object.freeze({
  sending: 'Debug logs on \u00b7 sending to the server',
  refused: 'Debug logs on \u00b7 the server is not accepting them',
  turnOff: 'Turn off',
});

export interface DebugEntry {
  readonly t: number;
  readonly level: DebugLevel;
  readonly event: string;
  readonly detail: string;
}

export interface DebugLogsOptions {
  /** `VITE_DEBUG_LOGS` as the build compiled it. Anything but exactly 'true' starts nothing. */
  readonly buildFlag: unknown;
  /** The World's bus: buildings entered and exited, stations activated. */
  readonly world?: EventBus<WorldEvents>;
  /** The page: its URL, session storage, document and events. The real window by default. */
  readonly page?: Window;
  /**
   * Where batches go. By default the global fetch as it was before this
   * module wrapped it, so the logger never observes its own requests.
   */
  readonly fetch?: typeof fetch;
  readonly sendBeacon?: (url: string, data: Blob) => boolean;
  readonly now?: () => number;
  readonly createSessionId?: () => string;
}

export interface DebugLogs {
  /** This browser session's random id. */
  readonly session: string;
  /** Send one batch of what is buffered now. */
  flush(): Promise<void>;
  /** The badge's button: send what was captured, forget the opt-in, restore the page. */
  turnOff(): void;
}

let active: { stop(): void } | null = null;

/**
 * Start the logger if both gates are open, or return null having touched
 * nothing but the `debug` URL parameter. Starting again replaces a running
 * logger, which is what a hot-module re-run of `main.tsx` does.
 */
export function startDebugLogs(options: DebugLogsOptions): DebugLogs | null {
  if (options.buildFlag !== 'true') return null;
  const page = options.page ?? (typeof window === 'undefined' ? undefined : window);
  if (!page) return null;
  const storage = createViewerStorage(() => page.sessionStorage);
  const optedIn = readDebugOptIn(page.location.search, storage);
  forgetDebugParameter(page);
  stopDebugLogs();
  return optedIn ? createDebugLogs(page, storage, options) : null;
}

/** Uninstall a running logger without forgetting the opt-in. */
export function stopDebugLogs(): void {
  const running = active;
  active = null;
  running?.stop();
}

/**
 * The runtime opt-in. `?debug=1` turns it on and remembers it for this
 * browser session; `?debug=0` turns it off; otherwise the remembered choice
 * stands. Storage that cannot be read or written only forgets the choice.
 */
export function readDebugOptIn(search: string, storage: ViewerStorage): boolean {
  let requested: string | null = null;
  try {
    requested = new URLSearchParams(search).get('debug');
  } catch {
    requested = null;
  }
  if (requested === '1') {
    storage.write(OPT_IN_KEY, 'on');
    return true;
  }
  if (requested === '0') {
    storage.remove(OPT_IN_KEY);
    return false;
  }
  return storage.read(OPT_IN_KEY) === 'on';
}

/** Drop the consumed `debug` parameter, so a reload follows the remembered choice. */
function forgetDebugParameter(page: Window): void {
  try {
    const url = new URL(page.location.href);
    if (!url.searchParams.has('debug')) return;
    url.searchParams.delete('debug');
    page.history.replaceState(page.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // A page that cannot rewrite its URL keeps the parameter.
  }
}

function sessionIdFrom(storage: ViewerStorage, create: () => string): string {
  const stored = storage.read(SESSION_KEY);
  if (stored !== null && SESSION_ID.test(stored)) return stored;
  let created: string;
  try {
    created = create();
  } catch {
    created = '';
  }
  const id = SESSION_ID.test(created) ? created : fallbackSessionId();
  storage.write(SESSION_KEY, id);
  return id;
}

/** 122 random bits, from nothing but the browser's generator. */
export function randomSessionId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && SESSION_ID.test(uuid)) return uuid;
  } catch {
    // Outside a secure context: fall through.
  }
  return fallbackSessionId();
}

function fallbackSessionId(): string {
  try {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return `${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

interface Prepared {
  readonly json: string;
  readonly bytes: number;
}

function createDebugLogs(page: Window, storage: ViewerStorage, options: DebugLogsOptions): DebugLogs {
  const now = options.now ?? Date.now;
  const session = sessionIdFrom(storage, options.createSessionId ?? randomSessionId);
  // The Shell and the relay client call the global fetch and console, so
  // those are what is watched; in a browser they are the page's own.
  const globalFetch: typeof fetch | undefined = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;
  const network: typeof fetch = options.fetch ?? ((input, init) => {
    if (!globalFetch) return Promise.reject(new TypeError('fetch is unavailable'));
    return Reflect.apply(globalFetch, globalThis, [input, init]) as Promise<Response>;
  });
  const sendBeacon = options.sendBeacon ?? ((url: string, data: Blob) => page.navigator.sendBeacon(url, data));
  const envelope = `{"v":1,"session":${JSON.stringify(session)},"entries":[`;
  const envelopeBytes = utf8Length(envelope) + 2;
  const buffer: Prepared[] = [];
  let droppedHere = 0;
  let state: 'sending' | 'refused' | 'off' = 'sending';
  let inFlight = false;
  let recording = false;
  let lastWallet: string | null = null;
  const undo: Array<() => void> = [];

  function record(level: DebugLevel, event: string, detail: string): void {
    if (state !== 'sending' || recording) return;
    recording = true;
    try {
      if (buffer.length >= MAX_BUFFERED_ENTRIES) {
        droppedHere += 1;
        return;
      }
      buffer.push(prepare({ t: now(), level, event: eventName(event), detail: cleanText(detail) }));
    } catch {
      // A value that cannot be described is not worth failing the page for.
    } finally {
      recording = false;
    }
  }

  function prepare(entry: DebugEntry): Prepared {
    const json = JSON.stringify(entry);
    return { json, bytes: utf8Length(json) };
  }

  /** One request body: up to 50 entries and 32 KB, oldest first. */
  function takeBatch(): string | null {
    if (droppedHere > 0) {
      buffer.push(prepare({
        t: now(),
        level: 'warn',
        event: 'debug.dropped',
        detail: `${droppedHere} ${droppedHere === 1 ? 'entry' : 'entries'} dropped in the browser while its buffer was full`,
      }));
      droppedHere = 0;
    }
    const taken: string[] = [];
    let bytes = envelopeBytes;
    while (buffer.length > 0 && taken.length < MAX_BATCH_ENTRIES) {
      const next = buffer[0]!;
      const cost = next.bytes + (taken.length > 0 ? 1 : 0);
      if (bytes + cost > MAX_BATCH_BYTES) {
        if (taken.length > 0) break;
        buffer.shift(); // Larger than any batch alone; cannot happen at 2,000 characters.
        continue;
      }
      bytes += cost;
      taken.push(next.json);
      buffer.shift();
    }
    return taken.length > 0 ? `${envelope}${taken.join(',')}]}` : null;
  }

  async function post(body: string): Promise<void> {
    let response: Response;
    try {
      const signal = timeoutSignal(POST_TIMEOUT_MS);
      response = await network(DEBUG_LOGS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
        ...(signal ? { signal } : {}),
      });
    } catch {
      return; // A lost batch is not retried.
    }
    // The backend answers 404 while BACKEND_DEBUG_LOGS_ENABLED is off.
    if (response.status === 404 || response.status === 405) refuse();
  }

  async function flush(): Promise<void> {
    if (state !== 'sending' || inFlight) return;
    const body = takeBatch();
    if (body === null) return;
    inFlight = true;
    try {
      await post(body);
    } finally {
      inFlight = false;
    }
  }

  /** The page is going away: hand what is left to the browser. */
  function beaconFlush(): void {
    if (state !== 'sending') return;
    for (let sent = 0; sent < BEACON_BATCHES; sent += 1) {
      const body = takeBatch();
      if (body === null) return;
      let queued = false;
      try {
        queued = sendBeacon(DEBUG_LOGS_URL, new Blob([body], { type: 'application/json' })) === true;
      } catch {
        queued = false;
      }
      if (!queued) void post(body);
    }
  }

  function refuse(): void {
    if (state !== 'sending') return;
    state = 'refused';
    buffer.length = 0;
    droppedHere = 0;
    badge.say(DEBUG_COPY.refused);
  }

  function uninstall(): void {
    for (const step of undo.splice(0).reverse()) {
      try {
        step();
      } catch {
        // Keep restoring the rest.
      }
    }
  }

  function turnOff(): void {
    if (state === 'off') return;
    record('info', 'debug.off', 'turned off from the badge');
    beaconFlush();
    state = 'off';
    storage.remove(OPT_IN_KEY);
    stop();
  }

  function stop(): void {
    state = 'off';
    if (active === handle) active = null;
    uninstall();
  }

  const handle = { stop };
  active = handle;

  const badge = mountBadge(page.document, session, turnOff);
  undo.push(() => badge.remove());

  const timer = globalThis.setInterval(() => void flush(), DEBUG_FLUSH_MS);
  undo.push(() => globalThis.clearInterval(timer));

  const onPageHide = (): void => beaconFlush();
  page.addEventListener('pagehide', onPageHide);
  undo.push(() => page.removeEventListener('pagehide', onPageHide));

  const onError = (event: Event): void => record('error', 'window.error', describeWindowError(event));
  page.addEventListener('error', onError);
  undo.push(() => page.removeEventListener('error', onError));

  const onRejection = (event: Event): void => {
    const reason = readEventField(event, 'reason');
    record('error', 'window.unhandledrejection', describeRejection(reason));
  };
  page.addEventListener('unhandledrejection', onRejection);
  undo.push(() => page.removeEventListener('unhandledrejection', onRejection));

  for (const method of ['error', 'warn'] as const) {
    undo.push(wrapConsole(globalThis.console, method, (args) => {
      record(method, `console.${method}`, args.map(describeValue).join(' '));
    }));
  }

  if (globalFetch) {
    undo.push(wrapFetch(page, globalFetch, {
      failed: (path, status, body) => record(status >= 500 ? 'error' : 'warn', 'api.failure', describeApiFailure(path, status, body)),
      unreachable: (path) => record('error', 'api.unreachable', path),
    }));
  }

  const world = options.world;
  if (world) {
    undo.push(world.on('building:entered', (payload) => {
      const owned = ownBuildingPayload(payload);
      if (owned) record('info', 'building.enter', owned.building);
    }));
    undo.push(world.on('building:exited', (payload) => {
      const owned = ownBuildingPayload(payload);
      if (owned) record('info', 'building.exit', owned.building);
    }));
    undo.push(world.on('building:locked', (payload) => {
      const owned = ownLockedBuildingPayload(payload);
      if (owned) record('info', 'building.locked', `${owned.building} ${owned.reason}`);
    }));
    undo.push(world.on('station:activated', (payload) => {
      const owned = ownStationPayload(payload);
      if (owned) record('info', 'station.activate', owned.station);
    }));
  }

  attachDebugTap({
    failure: (event, error) => record(failureLevel(error), event, describeFailure(error)),
    connectState: (state) => record('info', 'connect.state', describeConnectState(state)),
    walletSession: (snapshot) => {
      const summary = describeWalletSession(snapshot);
      if (summary === lastWallet) return;
      lastWallet = summary;
      record('info', 'wallet.session', summary);
    },
    visit: (previous, next) => {
      const closed = visitPanel(previous);
      const opened = visitPanel(next);
      if (closed !== opened) {
        if (closed) record('info', 'panel.close', closed);
        if (opened) record('info', 'panel.open', opened);
      }
      // D-076: a Privacy Plaza window, by station id alone.
      const plazaClosed = plazaPanel(previous);
      const plazaOpened = plazaPanel(next);
      if (plazaClosed === plazaOpened) return;
      if (plazaClosed) record('info', 'plaza.close', `station=${plazaClosed}`);
      if (plazaOpened) record('info', 'plaza.open', `station=${plazaOpened}`);
    },
    bank: (step) => {
      const entry = describeBankStep(step);
      if (entry) record(entry.level, entry.event, entry.detail);
    },
    sandboxBurst: (tile) => {
      const detail = describeSandboxTile(tile);
      if (detail) record('info', 'sandbox.burst', detail);
    },
    gate: (state) => {
      const entry = describeGateState(state);
      if (entry) record(entry.level, entry.event, entry.detail);
    },
    plazaShells: (result) => {
      const entry = describePlazaShells(result);
      if (entry) record(entry.level, entry.event, entry.detail);
    },
    // D-077: the Vault's probe steps, by code only.
    vault: (step) => {
      const entry = describeVaultStep(step);
      if (entry) record(entry.level, entry.event, entry.detail);
    },
    // D-078: the football's kicks, goals and full time, by side at most.
    football: (step) => {
      const entry = describeFootball(step);
      if (entry) record(entry.level, entry.event, entry.detail);
    },
    // D-122: the private placement's probe switch, receipts and DeFi ticks, by
    // reason code only. Never `p`, a commitment, a shadow address or the account.
    leaderboard: (step) => {
      const entry = describeLeaderboardStep(step);
      if (entry) record(entry.level, entry.event, entry.detail);
    },
  });
  undo.push(() => attachDebugTap(null));

  record('info', 'debug.on', `ua=${JSON.stringify(readUserAgent(page))}`);

  return Object.freeze({ session, flush, turnOff });
}

function wrapConsole(
  target: Console,
  method: 'error' | 'warn',
  observe: (args: unknown[]) => void,
): () => void {
  const original = target[method];
  if (typeof original !== 'function') return () => undefined;
  const wrapped = function debugConsole(this: unknown, ...args: unknown[]): void {
    try {
      observe(args);
    } catch {
      // Observing must never stop the message printing.
    }
    Reflect.apply(original, this, args);
  };
  target[method] = wrapped;
  return () => {
    if (target[method] === wrapped) target[method] = original;
  };
}

/**
 * Watch the page's own `/api` calls for failures. The relay client binds
 * `fetch` when its session is built, which is why `main.tsx` starts this
 * logger first. The wrapper hands back the untouched response; its body is
 * read from a clone, for the error code alone.
 */
function wrapFetch(
  page: Window,
  original: typeof fetch,
  report: {
    failed: (path: string, status: number, body: unknown) => void;
    unreachable: (path: string) => void;
  },
): () => void {
  const wrapped = async function debugFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const path = apiPath(input, page);
    let response: Response;
    try {
      response = await Reflect.apply(original, globalThis, [input, init]) as Response;
    } catch (error) {
      if (path !== null && !isAbort(error, init)) report.unreachable(path);
      throw error;
    }
    if (path !== null && !response.ok) {
      const status = response.status;
      let copy: Response | null = null;
      try {
        copy = response.clone();
      } catch {
        copy = null;
      }
      if (copy) {
        void copy.json().then((body: unknown) => report.failed(path, status, body), () => report.failed(path, status, null));
      } else {
        report.failed(path, status, null);
      }
    }
    return response;
  } as typeof fetch;
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}

/** A same-origin `/api` path without its query, or null. The logger's own endpoint is never watched. */
function apiPath(input: RequestInfo | URL, page: Window): string | null {
  try {
    const raw = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(raw, page.location.href);
    if (url.origin !== page.location.origin) return null;
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null;
    return url.pathname === DEBUG_LOGS_URL ? null : url.pathname;
  } catch {
    return null;
  }
}

function isAbort(error: unknown, init: RequestInit | undefined): boolean {
  try {
    if (init?.signal?.aborted) return true;
    return error instanceof DOMException && error.name === 'AbortError';
  } catch {
    return false;
  }
}

function describeWindowError(event: Event): string {
  const error = readEventField(event, 'error');
  const message = readEventField(event, 'message');
  const filename = readEventField(event, 'filename');
  const where = typeof filename === 'string' && filename
    ? ` at ${filename}:${String(readEventField(event, 'lineno'))}:${String(readEventField(event, 'colno'))}`
    : '';
  const what = error !== undefined && error !== null ? describeValue(error) : String(message ?? 'error');
  return `${what}${where}`;
}

function describeRejection(reason: unknown): string {
  return describeValue(reason);
}

/** A field of a browser-made event, read defensively. */
function readEventField(event: Event, key: string): unknown {
  try {
    return (event as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function readUserAgent(page: Window): string {
  try {
    return page.navigator.userAgent;
  } catch {
    return 'unknown';
  }
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

const BADGE_STYLE = [
  'position:fixed',
  'left:12px',
  'bottom:12px',
  'z-index:1000',
  'display:flex',
  'align-items:center',
  'gap:8px',
  'max-width:calc(100vw - 24px)',
  'padding:6px 10px',
  'border:1px solid #f5a524',
  'border-radius:6px',
  'background:#1b1b1f',
  'color:#ffffff',
  'font:12px/1.4 system-ui,sans-serif',
  'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
].join(';');

const BUTTON_STYLE = [
  'font:inherit',
  'color:inherit',
  'background:transparent',
  'border:1px solid currentColor',
  'border-radius:4px',
  'padding:2px 8px',
  'cursor:pointer',
].join(';');

function mountBadge(
  document: Document,
  session: string,
  onTurnOff: () => void,
): { say(text: string): void; remove(): void } {
  const badge = document.createElement('div');
  badge.setAttribute('role', 'status');
  badge.setAttribute('data-debug-logs', '');
  badge.title = `Debug session ${session}`;
  badge.style.cssText = BADGE_STYLE;
  const label = document.createElement('span');
  label.textContent = DEBUG_COPY.sending;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = DEBUG_COPY.turnOff;
  button.style.cssText = BUTTON_STYLE;
  button.addEventListener('click', onTurnOff);
  badge.append(label, button);
  (document.body ?? document.documentElement).append(badge);
  return {
    say(text) {
      label.textContent = text;
    },
    remove() {
      button.removeEventListener('click', onTurnOff);
      badge.remove();
    },
  };
}
