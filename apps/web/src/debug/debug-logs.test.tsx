// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_AREA, type WorldEvents } from '@strkworld/shared';
import { FakePrivacyOperations, mapWalletError, PrivacyError, type WalletSession } from '@strkworld/privacy';
import { createEventBus } from '../bus/event-bus.js';
import { createConnectFlow } from '../connect/connect-machine.js';
import { PrivacyProvider, usePrivacy } from '../privacy/PrivacyProvider.js';
import { toFailure } from '../privacy/errors.js';
import { createVisitController } from '../visits/visit-controller.js';
import { WalletSessionProvider, useWalletSessionOptional } from '../wallet/WalletSessionProvider.js';
import {
  DEBUG_COPY,
  DEBUG_FLUSH_MS,
  DEBUG_LOGS_URL,
  MAX_BATCH_BYTES,
  MAX_BATCH_ENTRIES,
  OPT_IN_KEY,
  SESSION_KEY,
  startDebugLogs,
  stopDebugLogs,
} from './debug-logs.js';
import {
  debugBank,
  debugConnectState,
  debugFailure,
  debugFootball,
  debugGate,
  debugLeaderboard,
  debugPlazaShells,
  debugSandboxBurst,
  debugVault,
  debugVisit,
  debugWalletSession,
} from './debug-tap.js';

/**
 * D-069 in the browser: two gates, then batches every 3 s, a beacon on the
 * way out, and the Shell's own failures and transitions as entries.
 */

interface SentEntry { t: number; level: string; event: string; detail: string }
interface SentBatch { v: number; session: string; entries: SentEntry[] }

const SESSION = 'test-session-0001';
const T0 = Date.UTC(2026, 8, 28, 16, 0, 0);
const NOT_REGISTERED =
  'kind=not-registered code=118 NOT_REGISTERED message="This wallet is not registered with the privacy pool." ' +
  'cause="An error occurred (NOT_REGISTERED)"';

const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: previousActEnvironment });
});

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  stopDebugLogs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  sessionStorage.clear();
});

function harness(options: { search?: string; flag?: unknown; status?: number; beacon?: boolean; page?: Window } = {}) {
  window.history.replaceState(null, '', `/${options.search ?? '?debug=1'}`);
  const sent: SentBatch[] = [];
  const bodies: string[] = [];
  const requests: RequestInit[] = [];
  const network = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    bodies.push(String(init?.body));
    sent.push(JSON.parse(String(init?.body)) as SentBatch);
    return new Response(null, { status: options.status ?? 202 });
  });
  const beacons: Blob[] = [];
  const sendBeacon = vi.fn((_url: string, data: Blob) => {
    beacons.push(data);
    return options.beacon ?? true;
  });
  const world = createEventBus<WorldEvents>();
  const logs = startDebugLogs({
    buildFlag: 'flag' in options ? options.flag : 'true',
    page: options.page ?? window,
    fetch: network as unknown as typeof fetch,
    sendBeacon,
    world,
    now: () => T0,
    createSessionId: () => SESSION,
  });
  const entries = (): SentEntry[] => sent.flatMap((batch) => batch.entries);
  const events = (): string[] => entries().map((entry) => entry.event);
  const tick = async (ms = DEBUG_FLUSH_MS): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  return { logs, sent, bodies, requests, network, beacons, sendBeacon, world, entries, events, tick };
}

function badge(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-debug-logs]');
}

async function beaconBatches(beacons: Blob[]): Promise<SentBatch[]> {
  return Promise.all(beacons.map(async (blob) => JSON.parse(await blob.text()) as SentBatch));
}

describe('the compile-time gate', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', true])('starts nothing with VITE_DEBUG_LOGS=%j, even with ?debug=1', async (flag) => {
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalFetch = globalThis.fetch;
    const { logs, network, sendBeacon, tick } = harness({ flag });
    expect(logs).toBeNull();
    debugFailure('privacy.operation', mapWalletError({ code: 118 }));
    window.dispatchEvent(new Event('pagehide'));
    await tick(10_000);
    expect(network).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(console.error).toBe(originalError);
    expect(console.warn).toBe(originalWarn);
    expect(globalThis.fetch).toBe(originalFetch);
    expect(badge()).toBeNull();
    expect(sessionStorage.getItem(OPT_IN_KEY)).toBeNull();
    // Not even the URL is touched.
    expect(window.location.search).toBe('?debug=1');
  });
});

describe('the runtime opt-in', () => {
  it('stays off without ?debug=1, so the taps send nothing', async () => {
    const originalError = console.error;
    const { logs, network, sendBeacon, tick } = harness({ search: '' });
    expect(logs).toBeNull();
    debugFailure('privacy.operation', mapWalletError({ code: 118 }));
    debugConnectState({ name: 'detecting' });
    debugWalletSession({ phase: 'connecting' });
    debugVisit({ name: 'outside' }, { name: 'locked', building: 'vault', reason: 'coming-soon' });
    debugBank({ step: 'mode', mode: 'unshield', from: 'shield' });
    debugSandboxBurst({ x: SANDBOX_AREA.x + 6, y: 10 });
    debugGate('checking');
    window.dispatchEvent(new Event('pagehide'));
    await tick(10_000);
    expect(network).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(console.error).toBe(originalError);
    expect(badge()).toBeNull();
  });

  it('turns on with ?debug=1, shows the badge and remembers it for this browser session', () => {
    const { logs } = harness();
    expect(logs?.session).toBe(SESSION);
    expect(badge()?.textContent).toContain('Debug logs on \u00b7 sending to the server');
    expect(badge()?.querySelector('button')?.textContent).toBe(DEBUG_COPY.turnOff);
    expect(sessionStorage.getItem(OPT_IN_KEY)).toBe('on');
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(SESSION);
    // The parameter is consumed; storage decides from here on.
    expect(window.location.search).toBe('');

    // A reload in the same browser session: no parameter, same session id.
    stopDebugLogs();
    expect(badge()).toBeNull();
    const reloaded = startDebugLogs({
      buildFlag: 'true',
      page: window,
      fetch: vi.fn() as unknown as typeof fetch,
      createSessionId: () => 'a-different-id-9',
    });
    expect(reloaded?.session).toBe(SESSION);
    expect(badge()).not.toBeNull();
  });

  it('keeps other query parameters when it consumes its own', () => {
    harness({ search: '?room=bank&debug=1#door' });
    expect(window.location.search).toBe('?room=bank');
    expect(window.location.hash).toBe('#door');
  });

  it('turns off with ?debug=0 and forgets the choice', () => {
    harness();
    stopDebugLogs();
    const { logs } = harness({ search: '?debug=0' });
    expect(logs).toBeNull();
    expect(sessionStorage.getItem(OPT_IN_KEY)).toBeNull();
    expect(badge()).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('still opts in for this page when session storage throws', () => {
    const hostile = new Proxy(window, {
      get(target, key) {
        if (key === 'sessionStorage') throw new DOMException('denied', 'SecurityError');
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const { logs } = harness({ page: hostile as Window });
    expect(logs?.session).toBe(SESSION);
    expect(badge()).not.toBeNull();
  });
});

describe('batching', () => {
  it('sends one batch every 3 s to the debug route, and nothing in between', async () => {
    const { network, requests, sent, tick } = harness();
    debugConnectState({ name: 'detecting' });
    await tick(DEBUG_FLUSH_MS - 1);
    expect(network).not.toHaveBeenCalled();
    await tick(1);
    expect(network).toHaveBeenCalledOnce();
    expect(network.mock.calls[0]![0]).toBe(DEBUG_LOGS_URL);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
    });
    expect(sent[0]).toEqual({
      v: 1,
      session: SESSION,
      entries: [
        { t: T0, level: 'info', event: 'debug.on', detail: expect.stringMatching(/^ua="/) },
        { t: T0, level: 'info', event: 'connect.state', detail: 'detecting' },
      ],
    });
    await tick(DEBUG_FLUSH_MS * 3);
    expect(network).toHaveBeenCalledOnce();
  });

  it('splits a burst into batches of at most 50 entries and 32 KB, in order', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bodies, entries, tick } = harness();
    for (let index = 0; index < 60; index += 1) console.warn(`burst ${index} ${'word '.repeat(300)}`);
    for (let index = 0; index < 60; index += 1) console.warn(`short ${index}`);
    await tick(DEBUG_FLUSH_MS * 10);
    expect(bodies.length).toBeGreaterThan(3);
    for (const body of bodies) {
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      expect((JSON.parse(body) as SentBatch).entries.length).toBeLessThanOrEqual(MAX_BATCH_ENTRIES);
    }
    const warned = entries().filter((entry) => entry.event === 'console.warn').map((entry) => entry.detail.split(' ', 2).join(' '));
    expect(warned).toEqual([
      ...Array.from({ length: 60 }, (_, index) => `burst ${index}`),
      ...Array.from({ length: 60 }, (_, index) => `short ${index}`),
    ]);
  });

  it('keeps at most 200 entries between flushes, and reports what it dropped', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { entries, tick } = harness();
    for (let index = 0; index < 250; index += 1) console.warn(`flood ${index}`);
    await tick(DEBUG_FLUSH_MS * 6);
    expect(entries().filter((entry) => entry.event === 'console.warn')).toHaveLength(199);
    expect(entries().filter((entry) => entry.event === 'debug.dropped')).toEqual([
      { t: T0, level: 'warn', event: 'debug.dropped', detail: '51 entries dropped in the browser while its buffer was full' },
    ]);
  });

  it('truncates a long detail to the server\'s 2,000 characters', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { entries, tick } = harness();
    console.error('long '.repeat(1_000));
    await tick();
    const detail = entries().find((entry) => entry.event === 'console.error')!.detail;
    expect(detail).toHaveLength(2_000);
    expect(detail.endsWith('\u2026')).toBe(true);
  });
});

describe('the page going away', () => {
  it('hands what is left to sendBeacon on pagehide, as JSON', async () => {
    const { beacons, network, sendBeacon } = harness();
    debugFailure('privacy.operation', toFailure(mapWalletError({ code: 118, message: 'An error occurred (NOT_REGISTERED)' })));
    window.dispatchEvent(new Event('pagehide'));
    expect(network).not.toHaveBeenCalled();
    expect(sendBeacon).toHaveBeenCalledOnce();
    expect(sendBeacon.mock.calls[0]![0]).toBe(DEBUG_LOGS_URL);
    expect(beacons[0]!.type).toBe('application/json');
    const [batch] = await beaconBatches(beacons);
    expect(batch).toMatchObject({ v: 1, session: SESSION });
    expect(batch!.entries.map((entry) => entry.event)).toEqual(['debug.on', 'privacy.operation']);
    // Nothing is left to send twice.
    window.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledOnce();
  });

  it('falls back to a keepalive fetch when the browser refuses the beacon', async () => {
    const { network, requests, sendBeacon } = harness({ beacon: false });
    window.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce());
    expect(requests[0]).toMatchObject({ keepalive: true });
  });
});

describe('what it captures', () => {
  it('captures a mapped wallet error with code 118: its kind, code and messages', async () => {
    const { entries, tick } = harness();
    debugFailure('privacy.operation', toFailure(mapWalletError({ code: 118, message: 'An error occurred (NOT_REGISTERED)' })));
    // The same code nested the way wallets nest it.
    debugFailure('privacy.operation', mapWalletError({ error: { code: 118, message: 'An error occurred (NOT_REGISTERED)' } }));
    await tick();
    expect(entries().filter((entry) => entry.event === 'privacy.operation')).toEqual([
      { t: T0, level: 'error', event: 'privacy.operation', detail: NOT_REGISTERED },
      { t: T0, level: 'error', event: 'privacy.operation', detail: NOT_REGISTERED },
    ]);
  });

  it('logs a declined request as a warning, not an error', async () => {
    const { entries, tick } = harness();
    debugFailure('wallet.connect', mapWalletError({ code: 113, message: 'An error occurred (USER_REFUSED_OP)' }));
    await tick();
    expect(entries().at(-1)).toEqual({
      t: T0,
      level: 'warn',
      event: 'wallet.connect',
      detail: 'kind=user-rejected code=113 USER_REFUSED_OP message="The wallet request was declined." cause="An error occurred (USER_REFUSED_OP)"',
    });
  });

  it('hears the failure at the PrivacyProvider funnel, and the connect room it escalates to', async () => {
    const { entries, tick } = harness();
    const mapped = mapWalletError({ code: 118, message: 'An error occurred (NOT_REGISTERED)' });
    function Fail() {
      const { noteOperationError } = usePrivacy();
      useEffect(() => noteOperationError(mapped), [noteOperationError]);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <PrivacyProvider operations={new FakePrivacyOperations()} initialConnectState={{ name: 'disconnected' }}>
          <Fail />
        </PrivacyProvider>,
      );
    });
    await act(async () => root.unmount());
    await tick();
    expect(entries().filter((entry) => entry.event !== 'debug.on')).toEqual([
      { t: T0, level: 'error', event: 'privacy.operation', detail: NOT_REGISTERED },
      { t: T0, level: 'info', event: 'connect.state', detail: 'not-registered' },
    ]);
  });

  it('records connect-flow states and a failed capability query', async () => {
    const { entries, tick } = harness();
    const connected = createConnectFlow({
      capability: async () => ({ supportsStrk20: true, walletApiVersion: '0.10', registration: 'unknown' }),
    } as never);
    await connected.connect();
    const unsupported = createConnectFlow({
      capability: async () => {
        throw mapWalletError({ code: 162, message: 'An error occurred (API_VERSION_NOT_SUPPORTED)' });
      },
    } as never);
    await unsupported.connect();
    const tooOld = createConnectFlow({
      capability: async () => ({ supportsStrk20: false, walletApiVersion: '0.9.0', registration: 'unknown' }),
    } as never);
    await tooOld.connect();
    await tick();
    expect(entries().filter((entry) => entry.event !== 'debug.on').map(({ level, event, detail }) => [level, event, detail])).toEqual([
      ['info', 'connect.state', 'detecting'],
      ['info', 'connect.state', 'connected strk20=true walletApi=0.10 registration=unknown confirmed=false'],
      ['info', 'connect.state', 'detecting'],
      [
        'error',
        'connect.capability',
        'kind=unsupported-wallet code=162 API_VERSION_NOT_SUPPORTED message="This wallet does not support the required STRK20 Wallet API." ' +
          'cause="An error occurred (API_VERSION_NOT_SUPPORTED)"',
      ],
      ['info', 'connect.state', 'unsupported-wallet walletApi=null'],
      ['info', 'connect.state', 'detecting'],
      ['info', 'connect.state', 'unsupported-wallet walletApi=0.9.0 tooOld=true'],
    ]);
  });

  it('records wallet-session snapshots as the Shell sees them, and a failed connect', async () => {
    const { entries, tick } = harness();
    const account = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
    let snapshot = Object.freeze({
      phase: 'selection-required' as const,
      wallets: Object.freeze([{ key: 'wallet-1', name: 'Ready', icon: `data:image/svg+xml;base64,${'A'.repeat(400)}` }]),
      selectedKey: null,
      account: null,
      generation: 0,
    });
    const listeners = new Set<() => void>();
    const session = {
      operations: {} as never,
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      connect: async () => {
        throw mapWalletError({ code: 113, message: 'An error occurred (USER_REFUSED_OP)' });
      },
      refreshDiscovery: () => undefined,
      readAccount: () => snapshot.account,
      disconnect: async () => undefined,
      destroy: () => undefined,
    } as unknown as WalletSession;
    let runtime: ReturnType<typeof useWalletSessionOptional> = null;
    function Capture() {
      runtime = useWalletSessionOptional();
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(<WalletSessionProvider session={session}><Capture /></WalletSessionProvider>);
    });
    await act(async () => {
      await expect(runtime!.connect('wallet-1')).rejects.toBeInstanceOf(PrivacyError);
    });
    await act(async () => {
      snapshot = Object.freeze({ ...snapshot, phase: 'connected' as const, selectedKey: 'wallet-1', account, generation: 1 }) as never;
      listeners.forEach((listener) => listener());
    });
    await act(async () => root.unmount());
    await tick();
    expect(entries().filter((entry) => entry.event !== 'debug.on').map(({ event, detail }) => [event, detail])).toEqual([
      ['wallet.session', 'phase=selection-required generation=0 wallets=1 selected=null account=null'],
      ['wallet.connect', 'kind=user-rejected code=113 USER_REFUSED_OP message="The wallet request was declined." cause="An error occurred (USER_REFUSED_OP)"'],
      ['wallet.session', `phase=connected generation=1 wallets=1 selected=wallet-1 account=${account}`],
    ]);
  });

  it('records buildings entered and exited, stations activated and panels opened and closed', async () => {
    const { entries, tick, world } = harness();
    const visits = createVisitController(createEventBus());
    const stop = visits.listen(world);
    world.emit('building:entered', { building: 'bank' });
    visits.openMenu();
    visits.closeSurface();
    world.emit('station:activated', { building: 'bank', station: 'bank:shielding' });
    world.emit('building:exited', { building: 'bank' });
    world.emit('building:locked', { building: 'vault', reason: 'coming-soon' });
    visits.dismissLocked();
    stop();
    await tick();
    expect(entries().filter((entry) => entry.event !== 'debug.on').map(({ event, detail }) => [event, detail])).toEqual([
      ['building.enter', 'bank'],
      ['panel.open', 'menu bank'],
      ['panel.close', 'menu bank'],
      ['station.activate', 'bank:shielding'],
      ['panel.open', 'station bank:shielding'],
      ['building.exit', 'bank'],
      ['panel.close', 'station bank:shielding'],
      ['building.locked', 'vault coming-soon'],
      ['panel.open', 'locked vault'],
      ['panel.close', 'locked vault'],
    ]);
  });

  it('wraps console.error and console.warn, which still print', async () => {
    const printedError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const printedWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { entries, tick } = harness();
    const failure = new TypeError('bad state');
    console.error('store: subscriber threw', failure);
    console.warn('careful', 42, { phase: 'connected' });
    expect(printedError).toHaveBeenCalledWith('store: subscriber threw', failure);
    expect(printedWarn).toHaveBeenCalledWith('careful', 42, { phase: 'connected' });
    await tick();
    const [errorEntry, warnEntry] = entries().filter((entry) => entry.event.startsWith('console.'));
    expect(errorEntry).toMatchObject({ level: 'error', event: 'console.error' });
    expect(errorEntry!.detail).toMatch(/^store: subscriber threw TypeError: bad state( at |$)/);
    expect(warnEntry).toEqual({ t: T0, level: 'warn', event: 'console.warn', detail: 'careful 42 {"phase":"connected"}' });
  });

  it('captures window errors and unhandled rejections', async () => {
    const { entries, tick } = harness();
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'Uncaught TypeError: x is undefined',
      filename: 'https://strkworld.example/assets/index-abc.js',
      lineno: 12,
      colno: 34,
      error: new TypeError('x is undefined'),
    }));
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new PrivacyError('unreachable', 'The private service could not be reached.') });
    window.dispatchEvent(rejection);
    await tick();
    const [error, unhandled] = entries().filter((entry) => entry.event.startsWith('window.'));
    expect(error).toMatchObject({ level: 'error', event: 'window.error' });
    expect(error!.detail).toMatch(/^TypeError: x is undefined .*at https:\/\/strkworld\.example\/assets\/index-abc\.js:12:34$/);
    expect(unhandled).toMatchObject({ level: 'error', event: 'window.unhandledrejection' });
    expect(unhandled!.detail).toMatch(/^kind=unreachable message="The private service could not be reached\."/);
  });

  it('records a failed /api response by path, status and body code only', async () => {
    const app = vi.fn(async (input: RequestInfo | URL) => {
      const raw = input instanceof Request ? input.url : String(input);
      const url = raw.startsWith('https://rpc.example') ? raw : new URL(raw, window.location.href).pathname;
      if (url.endsWith('/v1/private/fees')) {
        return new Response(JSON.stringify({ code: 'HTTP_400', message: 'Fee token 0xabc is not allowlisted.' }), { status: 400 });
      }
      if (url.endsWith('/v1/private/submissions')) {
        return new Response(JSON.stringify({ code: 'UPSTREAM_FAILURE', message: 'A private service dependency failed.' }), { status: 502 });
      }
      if (url.endsWith('/v1/rpc/receipt')) throw new TypeError('Failed to fetch');
      if (url.startsWith('https://rpc.example')) return new Response('nope', { status: 500 });
      return new Response('{}', { status: 200 });
    });
    globalThis.fetch = app as unknown as typeof fetch;
    const { entries, network, tick } = harness();
    const fees = await fetch('/api/v1/private/fees', { method: 'POST', body: JSON.stringify({ v: 1, feeToken: '0xabc' }) });
    // The caller still owns its response body.
    await expect(fees.json()).resolves.toEqual({ code: 'HTTP_400', message: 'Fee token 0xabc is not allowlisted.' });
    await fetch(new Request(`${window.location.origin}/api/v1/private/submissions?x=1`, { method: 'POST' }));
    await expect(fetch('/api/v1/rpc/receipt', { method: 'POST' })).rejects.toThrow('Failed to fetch');
    const aborted = new AbortController();
    aborted.abort();
    app.mockImplementationOnce(async () => { throw new DOMException('Aborted', 'AbortError'); });
    await expect(fetch('/api/v1/rpc/pool-config', { signal: aborted.signal })).rejects.toThrow('Aborted');
    await fetch('/api/v1/rpc/pool-config', { method: 'POST' });
    await fetch('https://rpc.example/v1', { method: 'POST' });
    await tick();
    // A failure's code is read from a clone of its body, so it can land after
    // a later request's entry; each entry carries its own time.
    const recorded = entries()
      .filter((entry) => entry.event.startsWith('api.'))
      .map(({ level, event, detail }) => [level, event, detail].join(' '));
    expect(recorded.sort()).toEqual([
      'error api.failure /api/v1/private/submissions 502 UPSTREAM_FAILURE',
      'error api.unreachable /api/v1/rpc/receipt',
      'warn api.failure /api/v1/private/fees 400 HTTP_400',
    ]);
    // The logger's own batches never pass through the watched fetch.
    expect(app.mock.calls.some(([input]) => String(input).includes(DEBUG_LOGS_URL))).toBe(false);
    expect(network).toHaveBeenCalled();
  });

  it('records Bank steps by code, intent kind and count, and drops anything else (D-070)', async () => {
    const { entries, tick } = harness();
    const address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
    debugBank({ step: 'mode', mode: 'unshield', from: 'shield' });
    debugBank({ step: 'add-refused', reason: 'mixed-shield-and-spend' });
    debugBank({ step: 'prepare', kinds: ['unshield'] });
    debugBank({ step: 'confirm', stage: 'proving' });
    debugBank({ step: 'confirm', stage: 'fee-moved' });
    // Whatever a caller passes, only listed codes are written: never an
    // amount, a recipient or a token address.
    debugBank({ step: 'mode', mode: address, from: 'shield' });
    debugBank({ step: 'add-refused', reason: `amount 1.5 to ${address}` });
    debugBank({ step: 'prepare', kinds: ['unshield', address] });
    debugBank({ step: 'prepare', kinds: [] });
    debugBank({ step: 'confirm', stage: '1500000000000000000' });
    debugBank({ step: 'balance', total: '100' } as never);
    debugBank({ step: 'prepare', kinds: [{ kind: 'unshield', amount: 1n, recipient: address }] } as never);
    await tick();
    expect(entries().filter((entry) => entry.event.startsWith('bank.')).map(({ level, event, detail }) => [level, event, detail])).toEqual([
      ['info', 'bank.mode', 'mode=unshield from=shield'],
      ['warn', 'bank.add-refused', 'reason=mixed-shield-and-spend'],
      ['info', 'bank.prepare', 'intents=1 kinds=unshield'],
      ['info', 'bank.confirm', 'stage=proving'],
      ['info', 'bank.confirm', 'stage=fee-moved'],
    ]);
    expect(JSON.stringify(entries())).not.toContain(address);
  });

  it('records the private placement by reason code at most, and never the season value (D-122)', async () => {
    const { entries, tick } = harness();
    // The season partial commitment, a commitment, a shadow address and the
    // account: none of them may reach a line, however a caller offers them.
    const partial = '0x1b5eed51de';
    const account = '0x04cafef00dbabe';
    debugLeaderboard({ event: 'probe', on: true, reason: 'url-on', build: true });
    debugLeaderboard({ event: 'probe', on: false, reason: 'not-asked', build: false });
    debugLeaderboard({ event: 'receipt', attached: true });
    debugLeaderboard({ event: 'receipt', attached: false, reason: 'no-ledger' });
    debugLeaderboard({ event: 'receipt', attached: false, reason: 'scan-failed' });
    debugLeaderboard({ event: 'receipt', attached: false, reason: 'unsupported-route' });
    debugLeaderboard({ event: 'tick', feature: 'vault' });
    debugLeaderboard({ event: 'tick', feature: 'swap' });
    // Refused: a reason that is not a code, a feature that is not a counter, an
    // event nobody declared, and a getter.
    debugLeaderboard({ event: 'probe', on: true, reason: partial, build: true });
    debugLeaderboard({ event: 'receipt', attached: false, reason: partial });
    // Admitted, but written from the fixed list alone: the extra field is
    // simply never read, so the line is the plain one.
    debugLeaderboard({ event: 'receipt', attached: true, commitment: partial } as never);
    debugLeaderboard({ event: 'tick', feature: partial });
    debugLeaderboard({ event: 'check-in', account } as never);
    debugLeaderboard(Object.defineProperty({ event: 'tick' }, 'feature', { get: () => 'vault' }) as never);
    await tick();
    expect(entries().filter((entry) => entry.event.startsWith('leaderboard.')).map(({ level, event, detail }) => [level, event, detail])).toEqual([
      ['info', 'leaderboard.probe', 'on=true reason=url-on build=on'],
      ['info', 'leaderboard.probe', 'on=false reason=not-asked build=off'],
      ['info', 'leaderboard.receipt', 'attached=true'],
      ['info', 'leaderboard.receipt', 'attached=false reason=no-ledger'],
      ['warn', 'leaderboard.receipt', 'attached=false reason=scan-failed'],
      ['warn', 'leaderboard.receipt', 'attached=false reason=unsupported-route'],
      ['info', 'leaderboard.tick', 'feature=vault'],
      ['info', 'leaderboard.tick', 'feature=swap'],
      ['info', 'leaderboard.receipt', 'attached=true'],
    ]);
    const surface = JSON.stringify(entries());
    expect(surface).not.toContain(partial);
    expect(surface).not.toContain(partial.slice(2));
    expect(surface).not.toContain(account);
  });

  it('records the football by side at most: a kick, a goal\'s side and full time\'s winner (D-078)', async () => {
    const { entries, tick } = harness();
    debugFootball({ event: 'kick' });
    debugFootball({ event: 'goal', side: 'starks' });
    debugFootball({ event: 'full-time', winner: 'snarks' });
    debugFootball({ event: 'goal', side: 'north' } as never);
    debugFootball({ event: 'goal', side: 'starks', scorer: '0123456789abcdef' } as never);
    debugFootball({ event: 'kick', x: 448, y: 480 } as never);
    debugFootball({ event: 'score', starks: 5 } as never);
    debugFootball(Object.defineProperty({ event: 'goal' }, 'side', { get: () => 'starks' }) as never);
    await tick();
    expect(entries().filter((entry) => entry.event.startsWith('football.')).map(({ level, event, detail }) => [level, event, detail])).toEqual([
      ['info', 'football.kick', ''],
      ['info', 'football.goal', 'side=starks'],
      ['info', 'football.full-time', 'winner=snarks'],
      ['info', 'football.goal', 'side=starks'],
      ['info', 'football.kick', ''],
    ]);
    const surface = JSON.stringify(entries());
    expect(surface).not.toContain('0123456789abcdef');
    expect(surface).not.toContain('448');
  });

  it('records a sandbox burst by its tile, and nothing but a tile inside the square (D-071)', async () => {
    const { entries, tick } = harness();
    // A tile six in from the square's gate, wherever the street puts the square (D-078).
    const x = SANDBOX_AREA.x + 6;
    debugSandboxBurst({ x, y: 10 });
    debugSandboxBurst({ x, y: 10, gameId: '0123456789abcdef' } as never);
    debugSandboxBurst({ x: 10, y: 10 });
    debugSandboxBurst({ x: SANDBOX_AREA.x - 1, y: 10 });
    debugSandboxBurst({ x: x + 0.5, y: 10 });
    debugSandboxBurst({ x: String(x), y: '10' } as never);
    debugSandboxBurst(Object.defineProperty({ y: 10 }, 'x', { get: () => x }) as never);
    await tick();
    expect(entries().filter((entry) => entry.event.startsWith('sandbox.')).map(({ level, event, detail }) => [level, event, detail])).toEqual([
      ['info', 'sandbox.burst', `x=${x} y=10`],
      ['info', 'sandbox.burst', `x=${x} y=10`],
    ]);
    expect(JSON.stringify(entries())).not.toContain('0123456789abcdef');
  });

  it('records entry-gate transitions by state name alone, and drops anything else (D-072)', async () => {
    const { entries, tick } = harness();
    const address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
    for (const name of ['ready', 'checking', 'deposit', 'review', 'depositing', 'landing', 'receipt-unreachable', 'passed']) debugGate(name);
    // Only the gate's own state names are ever written.
    debugGate(address);
    debugGate('deposit 12.5 STRK');
    debugGate({ name: 'passed' } as never);
    await tick();
    expect(entries().filter((entry) => entry.event.startsWith('gate.')).map(({ level, event, detail }) => [level, event, detail])).toEqual([
      ['info', 'gate.state', 'state=ready'],
      ['info', 'gate.state', 'state=checking'],
      ['info', 'gate.state', 'state=deposit'],
      ['info', 'gate.state', 'state=review'],
      ['info', 'gate.state', 'state=depositing'],
      ['info', 'gate.state', 'state=landing'],
      ['info', 'gate.state', 'state=receipt-unreachable'],
      ['info', 'gate.state', 'state=passed'],
    ]);
    expect(JSON.stringify(entries())).not.toContain(address);
    expect(JSON.stringify(entries())).not.toContain('12.5');
  });

  it('records Privacy Plaza windows by station and shell-game results by outcome, with no identifiers (D-076)', async () => {
    const { entries, tick, world } = harness();
    const visits = createVisitController(createEventBus());
    const stop = visits.listen(world);
    world.emit('station:activated', { building: 'plaza', station: 'plaza:shells' });
    debugPlazaShells('win');
    debugPlazaShells('lose');
    debugPlazaShells({ result: 'win', streak: 3 } as never);
    debugPlazaShells('0x0123456789abcdef' as never);
    visits.closeSurface();
    world.emit('station:activated', { building: 'plaza', station: 'plaza:monument' });
    visits.closeSurface();
    stop();
    await tick();
    expect(entries().filter((entry) => entry.event.startsWith('plaza.')).map(({ level, event, detail }) => [level, event, detail])).toEqual([
      ['info', 'plaza.open', 'station=plaza:shells'],
      ['info', 'plaza.shells', 'result=win'],
      ['info', 'plaza.shells', 'result=lose'],
      ['info', 'plaza.close', 'station=plaza:shells'],
      ['info', 'plaza.open', 'station=plaza:monument'],
      ['info', 'plaza.close', 'station=plaza:monument'],
    ]);
    // The activation itself is logged like any station's, and nothing else is.
    expect(entries().filter((entry) => entry.event === 'station.activate').map((entry) => entry.detail)).toEqual(['plaza:shells', 'plaza:monument']);
    expect(JSON.stringify(entries())).not.toContain('0123456789abcdef');
    expect(JSON.stringify(entries())).not.toContain('streak');
  });

  it('records the Vault probe by yes/no, stage and wallet code, and nothing that names a position (D-077)', async () => {
    const { entries, tick } = harness();
    const shadow = '0x24915cb456ef2876c9611af4f021747f8d9761ff2d7bc716722ce4527091ac9';
    debugVault({ step: 'capability', supported: true, walletApi: '0.10.4' });
    debugVault({ step: 'capability', supported: false, walletApi: null });
    debugVault({ step: 'stage', stage: { stage: 'capability', supported: true } });
    debugVault({ step: 'stage', stage: { stage: 'commitment', ok: false, code: 118 } });
    debugVault({ step: 'stage', stage: { stage: 'commitment', ok: false, code: -32601 } });
    debugVault({ step: 'stage', stage: { stage: 'commitment', ok: false, code: 113 } });
    debugVault({ step: 'stage', stage: { stage: 'commitment', ok: true } });
    debugVault({ step: 'stage', stage: { stage: 'address', resolved: true, deployed: false } });
    debugVault({ step: 'stage', stage: { stage: 'address', resolved: false } });
    debugVault({ step: 'stage', stage: { stage: 'position', ok: true } });
    debugVault({ step: 'prepare', kind: 'redeem', all: true });
    debugVault({ step: 'confirm', kind: 'supply', stage: 'awaiting-approval' });
    debugVault({ step: 'stage', stage: { stage: 'submit', ok: false, code: 162 } });
    debugVault({ step: 'stage', stage: { stage: 'submit', ok: true } });
    debugVault({ step: 'stage', stage: { stage: 'receipt', status: 'reverted' } });
    debugVault({ step: 'stage', stage: { stage: 'receipt', status: 'unreadable' } });
    debugVault({ step: 'confirm', kind: 'supply', stage: 'submitted' });
    // Whatever a caller passes, only listed shapes are written: never an
    // address, an amount, a balance, the commitment or a hash.
    debugVault({ step: 'capability', supported: true, walletApi: shadow });
    debugVault({ step: 'stage', stage: { stage: 'address', resolved: true, deployed: false, address: shadow } });
    debugVault({ step: 'stage', stage: { stage: 'commitment', ok: false, code: shadow } });
    debugVault({ step: 'stage', stage: { stage: 'position', ok: true, shares: 5n } });
    debugVault({ step: 'stage', stage: { stage: 'receipt', status: shadow } });
    debugVault({ step: 'prepare', kind: shadow, all: false } as never);
    debugVault({ step: 'confirm', kind: 'supply', stage: '5000000000000000000' });
    debugVault({ step: 'position', assets: '51' } as never);
    await tick();
    expect(entries().filter((entry) => entry.event.startsWith('vault.')).map(({ level, event, detail }) => [level, event, detail])).toEqual([
      ['info', 'vault.capability', 'supported=true walletApi=0.10.4'],
      ['warn', 'vault.capability', 'supported=false walletApi=none'],
      ['info', 'vault.capability', 'supported=true'],
      ['error', 'vault.commitment', 'ok=false code=118 NOT_REGISTERED'],
      ['error', 'vault.commitment', 'ok=false code=-32601'],
      ['warn', 'vault.commitment', 'ok=false code=113 USER_REFUSED_OP'],
      ['info', 'vault.commitment', 'ok=true'],
      ['info', 'vault.address', 'resolved=true deployed=false'],
      ['error', 'vault.address', 'resolved=false'],
      ['info', 'vault.position', 'ok=true'],
      ['info', 'vault.prepare', 'kind=redeem all=true'],
      ['info', 'vault.confirm', 'kind=supply stage=awaiting-approval'],
      ['error', 'vault.submit', 'ok=false code=162 API_VERSION_NOT_SUPPORTED'],
      ['info', 'vault.submit', 'ok=true'],
      ['error', 'vault.receipt', 'status=reverted'],
      ['warn', 'vault.receipt', 'status=unreadable'],
      ['info', 'vault.confirm', 'kind=supply stage=submitted'],
      // The address carried alongside a well-formed stage is never read.
      ['info', 'vault.address', 'resolved=true deployed=false'],
      ['info', 'vault.position', 'ok=true'],
    ]);
    expect(JSON.stringify(entries())).not.toContain(shadow.slice(2, 20));
    expect(JSON.stringify(entries())).not.toMatch(/5000000000000000000|shares|assets/);
  });

  it('records the Borrow counter\'s steps as the Vault\'s, by kind and stage only (D-083)', async () => {
    const { entries, tick } = harness();
    debugVault({ step: 'prepare', kind: 'borrow', all: false });
    debugVault({ step: 'prepare', kind: 'repay', all: true });
    debugVault({ step: 'confirm', kind: 'withdraw-collateral', stage: 'submitted' });
    debugVault({ step: 'confirm', kind: 'add-collateral', stage: 'fee-moved' });
    debugVault({ step: 'prepare', kind: 'liquidate', all: false } as never);
    await tick();
    expect(entries().filter((entry) => entry.event.startsWith('vault.')).map(({ event, detail }) => [event, detail])).toEqual([
      ['vault.prepare', 'kind=borrow all=false'],
      ['vault.prepare', 'kind=repay all=true'],
      ['vault.confirm', 'kind=withdraw-collateral stage=submitted'],
      ['vault.confirm', 'kind=add-collateral stage=fee-moved'],
    ]);
  });

  it('names the relay failure kind, so a missing avnu key is legible in the log (D-070)', async () => {
    const { entries, tick } = harness();
    debugFailure('privacy.operation', new PrivacyError('relay-not-configured', 'The private relay is not configured on this deployment.'));
    await tick();
    expect(entries().at(-1)).toEqual({
      t: T0,
      level: 'error',
      event: 'privacy.operation',
      detail: 'kind=relay-not-configured message="The private relay is not configured on this deployment."',
    });
  });

  it('names the route a wallet refused, so a stake\'s 114 does not read as a bare kind=unknown', async () => {
    const { entries, tick } = harness();
    const refused = toFailure(mapWalletError({ code: 114, message: 'An error occurred (INVALID_REQUEST_PAYLOAD)' }));
    debugFailure('privacy.operation', { ...refused, operation: 'stake' });
    // Only a route name from the fixed list is written; anything else is dropped.
    debugFailure('privacy.operation', { ...refused, operation: '0xabc' });
    await tick();
    const tail =
      'kind=unknown code=114 INVALID_REQUEST_PAYLOAD message="The privacy operation failed." ' +
      'cause="An error occurred (INVALID_REQUEST_PAYLOAD)"';
    expect(entries().filter((entry) => entry.event === 'privacy.operation').map((entry) => entry.detail)).toEqual([
      `op=stake ${tail}`,
      tail,
    ]);
  });

  it('names a transfer recipient\'s 118 apart from the account\'s own, keeping the wallet code (D-074)', async () => {
    const { entries, tick } = harness();
    // As the adapter throws it: the recipient's kind over the wallet's own answer.
    debugFailure('privacy.operation', new PrivacyError(
      'recipient-not-registered',
      'The recipient is not registered with the privacy pool.',
      { code: 118, message: 'An error occurred (NOT_REGISTERED)' },
    ));
    await tick();
    expect(entries().at(-1)).toEqual({
      t: T0,
      level: 'error',
      event: 'privacy.operation',
      detail:
        'kind=recipient-not-registered code=118 NOT_REGISTERED message="The recipient is not registered with the privacy pool." ' +
        'cause="An error occurred (NOT_REGISTERED)"',
    });
  });

  it('never sends signatures, calldata or proof data, but may name an account', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { entries, tick } = harness();
    const account = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
    console.error('prepared', {
      account,
      call_data: ['0x1', '0x2', '0x3'],
      signature: ['0x3a', '0x4b'],
      proof: { data: 'AAAA', proof_facts: ['0x4'] },
      feeAuthorization: 'eyJ2IjoxfQ.c2lnbmF0dXJl',
      nested: { artifact: { call: {} } },
    });
    console.error(`wallet said: signature [0x1a2b, 0x3c4d] and calldata 0x1,0x2,0x3 for ${account}`);
    console.error(`proof ${'Zm9v'.repeat(40)} and hex 0x${'ab'.repeat(40)}`);
    await tick();
    const [structured, text, blobs] = entries().filter((entry) => entry.event === 'console.error').map((entry) => entry.detail);
    expect(structured).toBe(
      `prepared {"account":"${account}","call_data":[redacted],"signature":[redacted],"proof":[redacted],` +
        '"feeAuthorization":[redacted],"nested":{"artifact":[redacted]}}',
    );
    expect(text).toBe(`wallet said: signature [2 felts redacted] and calldata [3 felts redacted] for ${account}`);
    expect(blobs).toBe('proof [data redacted] and hex [hex redacted]');
  });
});

describe('turning it off', () => {
  it('the badge button sends what was captured, forgets the opt-in and restores the page', async () => {
    const originalError = console.error;
    const originalFetch = globalThis.fetch;
    const { beacons, network, sendBeacon, tick } = harness();
    expect(console.error).not.toBe(originalError);
    expect(globalThis.fetch).not.toBe(originalFetch);
    debugConnectState({ name: 'connected' });
    badge()!.querySelector('button')!.click();
    expect(sendBeacon).toHaveBeenCalledOnce();
    const [batch] = await beaconBatches(beacons);
    expect(batch!.entries.map((entry) => entry.event)).toEqual(['debug.on', 'connect.state', 'debug.off']);
    expect(badge()).toBeNull();
    expect(sessionStorage.getItem(OPT_IN_KEY)).toBeNull();
    expect(console.error).toBe(originalError);
    expect(globalThis.fetch).toBe(originalFetch);

    debugFailure('privacy.operation', mapWalletError({ code: 118 }));
    window.dispatchEvent(new Event('pagehide'));
    await tick(10_000);
    expect(network).not.toHaveBeenCalled();
    expect(sendBeacon).toHaveBeenCalledOnce();
    // A reload stays off.
    window.history.replaceState(null, '', '/');
    expect(startDebugLogs({ buildFlag: 'true', page: window })).toBeNull();
  });

  it('stops sending, and says so, when the backend has debug logs switched off', async () => {
    const { network, sendBeacon, tick } = harness({ status: 404 });
    await tick();
    expect(network).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(badge()?.textContent).toContain(DEBUG_COPY.refused));
    debugConnectState({ name: 'detecting' });
    window.dispatchEvent(new Event('pagehide'));
    await tick(DEBUG_FLUSH_MS * 3);
    expect(network).toHaveBeenCalledOnce();
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});

describe('the taps', () => {
  const hostile = new Proxy({}, {
    get() { throw new Error('trap'); },
    getOwnPropertyDescriptor() { throw new Error('trap'); },
    getPrototypeOf() { throw new Error('trap'); },
    ownKeys() { throw new Error('trap'); },
  });

  it('never throw into their callers, with or without a logger', async () => {
    const call = () => {
      debugFailure('privacy.operation', hostile);
      debugConnectState(hostile);
      debugWalletSession(hostile);
      debugVisit(hostile, { name: 'outside' });
      debugBank(hostile as never);
      debugSandboxBurst(hostile as never);
    };
    expect(call).not.toThrow();
    const { tick, entries } = harness();
    expect(call).not.toThrow();
    await tick();
    expect(entries().length).toBeGreaterThan(0);
  });
});
