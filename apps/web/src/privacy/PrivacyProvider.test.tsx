// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations } from '@strkworld/privacy';
import {
  PrivacyProvider,
  usePrivacy,
  walletSessionConnectAction,
  type ShellPrivacy,
} from './PrivacyProvider.js';
import { createSubmissionUncertainty } from './submission-uncertainty.js';

const previousActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterAll(() => {
  if (previousActEnvironment === undefined) {
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  } else {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: previousActEnvironment });
  }
});

function Probe() {
  const { connectState } = usePrivacy();
  return <p>{connectState.name}</p>;
}

function OperationProbe({ expected, stale }: { expected: object | null; stale: { current: boolean } }) {
  const { operations } = usePrivacy();
  if (operations !== expected) stale.current = true;
  useLayoutEffect(() => {
    if (operations !== expected) stale.current = true;
  }, [expected, operations, stale]);
  return null;
}

describe('PrivacyProvider', () => {
  it('publishes a replacement financial seam before child render effects can use the old one', async () => {
    const first = new FakePrivacyOperations();
    const second = new FakePrivacyOperations();
    const stale = { current: false };
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PrivacyProvider operations={first}>
          <OperationProbe expected={first} stale={stale} />
        </PrivacyProvider>,
      );
    });
    stale.current = false;

    flushSync(() => {
      root.render(
        <PrivacyProvider operations={second}>
          <OperationProbe expected={second} stale={stale} />
        </PrivacyProvider>,
      );
    });

    expect(stale.current).toBe(false);
    await act(async () => root.unmount());
  });

  it('publishes an immutable shell privacy context snapshot', () => {
    const operations = new FakePrivacyOperations();
    let captured!: ShellPrivacy;
    function Capture() {
      captured = usePrivacy();
      return null;
    }

    renderToStaticMarkup(
      <PrivacyProvider operations={operations}>
        <Capture />
      </PrivacyProvider>,
    );

    expect(Object.isFrozen(captured)).toBe(true);
    expect(Reflect.set(captured, 'operations', null)).toBe(false);
    expect(Reflect.set(captured, 'connect', null)).toBe(false);
    expect(captured.operations).toBe(operations);
    expect(captured.connectState.name).toBe('disconnected');
  });

  it('does not expose a retired real seam while the lazy demo seam loads', async () => {
    const first = new FakePrivacyOperations();
    const stale = { current: false };
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PrivacyProvider operations={first}>
          <OperationProbe expected={first} stale={stale} />
        </PrivacyProvider>,
      );
    });
    stale.current = false;

    flushSync(() => {
      root.render(
        <PrivacyProvider demo fallback={<p>loading</p>}>
          <OperationProbe expected={null} stale={stale} />
        </PrivacyProvider>,
      );
    });

    expect(container.innerHTML).toBe('<p>loading</p>');
    expect(stale.current).toBe(false);
    await act(async () => root.unmount());
  });

  it('retires and rechecks capability only when the connected wallet authority changes', () => {
    const connected = {
      phase: 'connected' as const,
      wallets: [],
      selectedKey: 'wallet-1',
      account: '0x111' as const,
      generation: 1,
    };

    expect(walletSessionConnectAction(connected, connected)).toBe('none');
    expect(walletSessionConnectAction(connected, {
      ...connected,
      account: '0x222',
      generation: 2,
    })).toBe('recheck');
    expect(walletSessionConnectAction(connected, {
      ...connected,
      phase: 'wrong-network',
      account: null,
      generation: 2,
    })).toBe('disconnect');
    expect(walletSessionConnectAction({
      ...connected,
      phase: 'selection-required',
      account: null,
    }, connected)).toBe('recheck');
  });

  it('refuses to invent a financial seam', () => {
    // The earlier version fell back to the deterministic fake, so a mis-wired
    // build would have shown a working Bank holding 250 STRK nobody owns.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      renderToStaticMarkup(
        <PrivacyProvider>
          <Probe />
        </PrivacyProvider>,
      ),
    ).toThrow(/needs an `operations` prop/);
    error.mockRestore();
  });

  it('uses the seam it is given', () => {
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <Probe />
      </PrivacyProvider>,
    );
    expect(markup).toContain('disconnected');
  });

  it('preserves an already-admitted production wallet capability on first render', () => {
    const markup = renderToStaticMarkup(
      <PrivacyProvider
        operations={new FakePrivacyOperations()}
        initialConnectState={{
          name: 'connected',
          capability: {
            supportsStrk20: true,
            walletApiVersion: '0.10.3',
            registration: 'unknown',
          },
          registrationConfirmed: false,
        }}
      >
        <Probe />
      </PrivacyProvider>,
    );

    expect(markup).toBe('<p>connected</p>');
  });

  it('refuses the demo seam in a production build', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      renderToStaticMarkup(
        <PrivacyProvider demo build={{ production: true }}>
          <Probe />
        </PrivacyProvider>,
      ),
    ).toThrow(/must never ship/);
    error.mockRestore();
  });

  it('loads the demo seam lazily, and only when asked for by name', () => {
    // Nothing renders until the dynamic import resolves, which is the point:
    // the seam pulls `starknet`, and the shell must render a connect screen
    // without it.
    const markup = renderToStaticMarkup(
      <PrivacyProvider demo fallback={<p>loading</p>}>
        <Probe />
      </PrivacyProvider>,
    );
    expect(markup).toBe('<p>loading</p>');
  });

  it('routes an uncertain operation into provider-lifetime session memory', () => {
    const uncertainty = createSubmissionUncertainty();
    let shell: ShellPrivacy | null = null;
    function Capture() {
      shell = usePrivacy();
      return null;
    }
    renderToStaticMarkup(
      <PrivacyProvider
        operations={new FakePrivacyOperations()}
        submissionUncertainty={uncertainty}
      >
        <Capture />
      </PrivacyProvider>,
    );

    expect(shell).not.toBeNull();
    (shell as ShellPrivacy | null)?.noteOperationError({ kind: 'submission-uncertain' });

    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: false });
  });

  it('re-locks an acknowledged session when another uncertainty is reported', () => {
    const uncertainty = createSubmissionUncertainty();
    let shell: ShellPrivacy | null = null;
    function Capture() {
      shell = usePrivacy();
      return null;
    }
    renderToStaticMarkup(
      <PrivacyProvider
        operations={new FakePrivacyOperations()}
        submissionUncertainty={uncertainty}
      >
        <Capture />
      </PrivacyProvider>,
    );

    uncertainty.retain();
    uncertainty.acknowledge();
    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: true });
    (shell as ShellPrivacy | null)?.noteOperationError({ kind: 'submission-uncertain' });
    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: false });
  });
});
