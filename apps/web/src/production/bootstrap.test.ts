import { describe, expect, it, vi } from 'vitest';
import type { WalletSession } from '@strkworld/privacy';
import { startProductionWalletBootstrap } from './bootstrap.js';

function session(): WalletSession {
  return {
    operations: {} as never,
    getSnapshot: () => ({
      phase: 'selection-required',
      wallets: [],
      selectedKey: null,
      account: null,
      generation: 0,
    }),
    subscribe: () => () => undefined,
    connect: async () => { throw new Error('not used'); },
    refreshDiscovery: () => undefined,
    readAccount: () => null,
    disconnect: async () => undefined,
    destroy: vi.fn(),
  };
}

describe('production wallet bootstrap', () => {
  it('retires a session that resolves after hot disposal without publishing it', async () => {
    let resolve!: (value: WalletSession) => void;
    const loading = new Promise<WalletSession>((release) => { resolve = release; });
    const hot = { dispose: vi.fn() };
    const render = vi.fn();
    const failure = vi.fn();
    const dispose = startProductionWalletBootstrap({
      load: () => loading,
      render,
      failure,
      hot,
    });
    const late = session();

    hot.dispose.mock.calls[0]?.[0]();
    dispose();
    resolve(late);
    await Promise.resolve();

    expect(render).not.toHaveBeenCalled();
    expect(late.destroy).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
  });

  it('contains a failure renderer that throws after render fails', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      startProductionWalletBootstrap({
        load: async () => session(),
        render: () => { throw new Error('render failed'); },
        failure: () => { throw new Error('failure renderer failed'); },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('destroys a session when rendering the loaded session fails', async () => {
    const loaded = session();
    const failure = vi.fn();
    startProductionWalletBootstrap({
      load: async () => loaded,
      render: () => { throw new Error('render failed'); },
      failure,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(failure).toHaveBeenCalledOnce();
    expect(loaded.destroy).toHaveBeenCalledOnce();
  });

  it('does not double-destroy when disposal reenters a failing render', async () => {
    const loaded = session();
    const failure = vi.fn();
    let dispose!: () => void;
    dispose = startProductionWalletBootstrap({
      load: async () => loaded,
      render: () => {
        dispose();
        throw new Error('render failed after disposal');
      },
      failure,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(loaded.destroy).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
  });

  it('contains a loader that throws before returning a promise', async () => {
    const failure = vi.fn();
    expect(() => startProductionWalletBootstrap({
      load: () => { throw new Error('loader failed synchronously'); },
      render: vi.fn(),
      failure,
    })).not.toThrow();
    await Promise.resolve();
    expect(failure).toHaveBeenCalledOnce();
  });

  it('fails closed when hot disposal registration throws', () => {
    const failure = vi.fn();
    const load = vi.fn(async () => session());
    expect(() => startProductionWalletBootstrap({
      load,
      render: vi.fn(),
      failure,
      hot: { dispose: () => { throw new Error('hot registration failed'); } },
    })).not.toThrow();
    expect(failure).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
  });

  it('fails closed when the loader fulfills with a non-session value', async () => {
    const render = vi.fn();
    const failure = vi.fn();
    startProductionWalletBootstrap({
      load: async () => 42 as never,
      render,
      failure,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(render).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledOnce();
  });

  it('contains a thenable whose then getter throws', async () => {
    const failure = vi.fn();
    const malformed = {};
    Object.defineProperty(malformed, 'then', {
      get: () => { throw new Error('then getter failed'); },
    });
    expect(() => startProductionWalletBootstrap({
      load: () => malformed as never,
      render: vi.fn(),
      failure,
    })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(failure).toHaveBeenCalledOnce();
  });

  it('accepts only the first fulfillment of a thenable', async () => {
    const first = session();
    const second = session();
    const render = vi.fn();
    const thenable = {
      then(resolve: (value: WalletSession) => void): void {
        resolve(first);
        resolve(second);
      },
    };
    startProductionWalletBootstrap({
      load: () => thenable as never,
      render,
      failure: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith(first);
    expect(second.destroy).not.toHaveBeenCalled();
  });

  it('destroys a valid session through its data method despite a hostile get trap', async () => {
    const target = session();
    const loaded = new Proxy(target, {
      get(object, property, receiver) {
        if (property === 'destroy') throw new Error('destroy getter trapped');
        return Reflect.get(object, property, receiver);
      },
    });
    const dispose = startProductionWalletBootstrap({
      load: async () => loaded,
      render: vi.fn(),
      failure: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();
    dispose();

    expect(target.destroy).toHaveBeenCalledOnce();
  });
});
