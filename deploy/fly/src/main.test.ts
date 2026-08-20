import { describe, expect, it } from 'vitest';
import { FlyStartupAbortError, type FlyComposition, type FlyCompositionOptions } from './compose';
import { parseFlyEnvironment, runFlySupervisor, type FlySupervisorSignals } from './main';

class FakeSignals implements FlySupervisorSignals {
  private readonly listeners = new Map<'SIGTERM' | 'SIGINT', Set<() => void>>([
    ['SIGTERM', new Set()],
    ['SIGINT', new Set()],
  ]);

  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void {
    this.listeners.get(signal)?.add(listener);
  }

  removeListener(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: 'SIGTERM' | 'SIGINT'): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  count(signal: 'SIGTERM' | 'SIGINT'): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

const compositionOptions: Omit<FlyCompositionOptions, 'onFatal' | 'startupSignal'> = {
  staticRoot: '/tmp/static',
  backendEntry: '/tmp/backend.js',
  lobbyEntry: '/tmp/lobby.js',
  publicPort: 8080,
  backendPort: 18080,
  lobbyPort: 12567,
  publicOrigin: 'https://game.example',
};

const rejectedPublicOrigins = [
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
  'https://yourhost.example',
  'https://your_host.example',
  'https://your-host.example',
  'https://yourhostname.example',
  'https://your_hostname.example',
  'https://yourdomain.example',
  'https://your-domain.example',
  'https://your.host.example',
];

const acceptedPublicOrigins = [
  'https://your-company.com',
  'https://replaceable.example.com',
  'https://placeholdertech.com',
];

function composition(shutdown: () => Promise<void> = async () => undefined): FlyComposition {
  return { address: { address: '0.0.0.0', family: 'IPv4', port: 8080 }, shutdown };
}

describe('Fly supervisor lifecycle', () => {
  it.each(rejectedPublicOrigins)('rejects non-production public origin %s with a generic Fly error', (publicOrigin) => {
    let thrown: unknown;
    try {
      parseFlyEnvironment({
        PORT: '8080',
        FLY_PUBLIC_ORIGIN: publicOrigin,
        FLY_BUILT_LOBBY_URL: 'wss://runtime-override.example',
        LOBBY_ALLOWED_ORIGINS: publicOrigin,
      }, 'wss://game.example');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toBe('Invalid FLY_PUBLIC_ORIGIN.');
    expect(message).not.toContain(publicOrigin);
  });

  it.each(acceptedPublicOrigins)('accepts legitimate substring domain %s', (publicOrigin) => {
    expect(parseFlyEnvironment({
      PORT: '8080',
      FLY_PUBLIC_ORIGIN: publicOrigin,
      FLY_BUILT_LOBBY_URL: 'wss://runtime-override.example',
      LOBBY_ALLOWED_ORIGINS: publicOrigin,
    }, publicOrigin.replace(/^https:/, 'wss:'))).toMatchObject({ publicOrigin });
  });

  it.each([
    ['missing', undefined],
    ['different-host', 'wss://other.example'],
    ['different-port', 'wss://game.example:8443'],
    ['wrong-scheme', 'https://game.example'],
  ])('rejects a %s baked lobby endpoint without echoing it', (_case, builtLobbyUrl) => {
    let thrown: unknown;
    try {
      parseFlyEnvironment({
        PORT: '8080',
        FLY_PUBLIC_ORIGIN: 'https://game.example',
        FLY_BUILT_LOBBY_URL: 'wss://game.example',
        LOBBY_ALLOWED_ORIGINS: 'https://game.example',
      }, builtLobbyUrl);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toBe('Invalid FLY_BUILT_LOBBY_URL.');
    if (builtLobbyUrl) expect(message).not.toContain(builtLobbyUrl);
  });

  it('binds an explicit public port to the same baked lobby port', () => {
    expect(parseFlyEnvironment({
      PORT: '8080',
      FLY_PUBLIC_ORIGIN: 'https://game.example:8443',
      FLY_BUILT_LOBBY_URL: 'wss://runtime-override.example',
      LOBBY_ALLOWED_ORIGINS: 'https://game.example:8443',
    }, 'wss://game.example:8443')).toMatchObject({ publicOrigin: 'https://game.example:8443' });
  });

  it('aborts deferred startup and exits orderly when a signal arrives', async () => {
    const signals = new FakeSignals();
    const exitCodes: number[] = [];
    let aborted = false;
    const start = async (options: FlyCompositionOptions): Promise<FlyComposition> => {
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          aborted = true;
          reject(new FlyStartupAbortError());
        };
        if (options.startupSignal?.aborted) onAbort();
        else options.startupSignal?.addEventListener('abort', onAbort, { once: true });
      });
      throw new Error('unreachable');
    };

    const running = runFlySupervisor({ compositionOptions, start, signals, exit: (code) => exitCodes.push(code) });
    await Promise.resolve();
    signals.emit('SIGTERM');
    await running;

    expect(aborted).toBe(true);
    expect(exitCodes).toEqual([0]);
    expect(signals.count('SIGTERM')).toBe(0);
    expect(signals.count('SIGINT')).toBe(0);
  });

  it('exits fatally when an orderly startup abort encounters cleanup failure', async () => {
    const signals = new FakeSignals();
    const exitCodes: number[] = [];
    const start = async (options: FlyCompositionOptions): Promise<FlyComposition> => {
      await new Promise<void>((resolve) => {
        if (options.startupSignal?.aborted) resolve();
        else options.startupSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('startup cleanup failed');
    };

    const running = runFlySupervisor({ compositionOptions, start, signals, exit: (code) => exitCodes.push(code) });
    await Promise.resolve();
    signals.emit('SIGTERM');
    await running;

    expect(exitCodes).toEqual([1]);
    expect(signals.count('SIGTERM')).toBe(0);
    expect(signals.count('SIGINT')).toBe(0);
  });

  it('cleans up a composition when fatal wins during the startup handoff', async () => {
    const signals = new FakeSignals();
    const exitCodes: number[] = [];
    let fatal: ((error: Error) => void) | undefined;
    let shutdowns = 0;
    const start = async (options: FlyCompositionOptions): Promise<FlyComposition> => {
      fatal = options.onFatal;
      options.onFatal?.(new Error('child died'));
      return composition(async () => { shutdowns += 1; });
    };

    await runFlySupervisor({ compositionOptions, start, signals, exit: (code) => exitCodes.push(code) });

    expect(fatal).toBeDefined();
    expect(shutdowns).toBe(1);
    expect(exitCodes).toEqual([1]);
    expect(signals.count('SIGTERM')).toBe(0);
    expect(signals.count('SIGINT')).toBe(0);
  });

  it('coalesces duplicate and cross-signal orderly shutdowns', async () => {
    const signals = new FakeSignals();
    const exitCodes: number[] = [];
    let resolveStart: ((value: FlyComposition) => void) | undefined;
    let shutdowns = 0;
    const start = (_options: FlyCompositionOptions) => new Promise<FlyComposition>((resolve) => {
      resolveStart = resolve;
    });
    const running = runFlySupervisor({ compositionOptions, start, signals, exit: (code) => exitCodes.push(code) });
    await Promise.resolve();
    resolveStart?.(composition(async () => { shutdowns += 1; }));
    await running;

    signals.emit('SIGTERM');
    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));

    expect(shutdowns).toBe(1);
    expect(exitCodes).toEqual([0]);
  });

  it('exits fatally and disposes listeners when startup rejects', async () => {
    const signals = new FakeSignals();
    const exitCodes: number[] = [];
    const start = async (_options: FlyCompositionOptions): Promise<FlyComposition> => {
      throw new Error('startup failed');
    };

    await runFlySupervisor({ compositionOptions, start, signals, exit: (code) => exitCodes.push(code) });

    expect(exitCodes).toEqual([1]);
    expect(signals.count('SIGTERM')).toBe(0);
    expect(signals.count('SIGINT')).toBe(0);
  });

  it('turns cleanup rejection into fatal exit', async () => {
    const signals = new FakeSignals();
    const exitCodes: number[] = [];
    let shutdowns = 0;
    const start = async (_options: FlyCompositionOptions): Promise<FlyComposition> => composition(async () => {
      shutdowns += 1;
      throw new Error('cleanup failed');
    });

    await runFlySupervisor({ compositionOptions, start, signals, exit: (code) => exitCodes.push(code) });
    signals.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));

    expect(shutdowns).toBe(1);
    expect(exitCodes).toEqual([1]);
    expect(signals.count('SIGTERM')).toBe(0);
    expect(signals.count('SIGINT')).toBe(0);
  });

  it('escalates an orderly request if a fatal callback arrives before cleanup completes', async () => {
    const signals = new FakeSignals();
    const exitCodes: number[] = [];
    let fatal: ((error: Error) => void) | undefined;
    let resolveCleanup: (() => void) | undefined;
    let resolveExit: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const start = async (options: FlyCompositionOptions): Promise<FlyComposition> => {
      fatal = options.onFatal;
      return composition(() => new Promise<void>((resolve) => { resolveCleanup = resolve; }));
    };

    await runFlySupervisor({
      compositionOptions,
      start,
      signals,
      exit: (code) => {
        exitCodes.push(code);
        resolveExit?.();
      },
    });
    signals.emit('SIGTERM');
    fatal?.(new Error('child died'));
    await Promise.resolve();
    resolveCleanup?.();
    await exited;

    expect(exitCodes).toEqual([1]);
  });
});
