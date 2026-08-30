// @vitest-environment jsdom
import { act, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BridgeProvider, useBridge, type BridgeRuntime } from './BridgeProvider.js';

function Probe() {
  const bridge = useBridge();
  return <p
    data-available={bridge.available() ? 'yes' : 'no'}
    data-service={bridge.service ? 'yes' : 'no'}
    data-owner={(bridge.service as { owner?: string } | null)?.owner ?? 'none'}
  >{bridge.account ?? 'none'}</p>;
}

function LoadProbe({ start }: { start: boolean }) {
  const bridge = useBridge();
  useEffect(() => {
    if (start) bridge.load();
  }, [start, bridge.load]);
  return <Probe />;
}

describe('BridgeProvider', () => {
  it('publishes an immutable runtime snapshot at the public context seam', () => {
    let captured!: BridgeRuntime;
    function Capture() {
      captured = useBridge();
      return null;
    }
    const service = {} as never;
    const planner = { planMax: async () => { throw new Error('unused'); } };

    renderToStaticMarkup(
      <BridgeProvider service={service} planner={planner} account="0x123">
        <Capture />
      </BridgeProvider>,
    );

    expect(Object.isFrozen(captured)).toBe(true);
    expect(Reflect.set(captured, 'account', null)).toBe(false);
    expect(Reflect.set(captured, 'planner', null)).toBe(false);
    expect(captured.account).toBe('0x123');
    expect(captured.planner).toBe(planner);
    expect(captured.available()).toBe(true);
  });

  it('refuses the deterministic demo in production', () => {
    expect(() => renderToStaticMarkup(
      <BridgeProvider demo build={{ production: true }}><Probe /></BridgeProvider>,
    )).toThrow(/demo.*production/i);
  });

  it('does not claim capability when a planner exists without a current account snapshot', () => {
    const service = {} as never;
    const planner = { planMax: async () => { throw new Error('unused'); } };
    const markup = renderToStaticMarkup(
      <BridgeProvider service={service} planner={planner} account={null}><Probe /></BridgeProvider>,
    );
    expect(markup).toContain('data-available="no"');
    expect(markup).toContain('none');
  });

  it('renders an unavailable runtime when no service is supplied', () => {
    const service = {} as never;
    const planner = { planMax: async () => { throw new Error('unused'); } };
    const live = renderToStaticMarkup(
      <BridgeProvider service={service} planner={planner} account="0x123"><Probe /></BridgeProvider>,
    );
    const absent = renderToStaticMarkup(<BridgeProvider><Probe /></BridgeProvider>);

    expect(live).toContain('data-available="yes"');
    expect(absent).toContain('data-available="no"');
  });

  it('refuses demo mode in production even when a service is supplied', () => {
    const service = {} as never;
    expect(() => renderToStaticMarkup(
      <BridgeProvider service={service} demo build={{ production: true }}><Probe /></BridgeProvider>,
    )).toThrow(/demo.*production/i);
  });

  it('derives a supplied live service during render', () => {
    const service = {} as never;
    const planner = { planMax: async () => { throw new Error('unused'); } };
    const absent = renderToStaticMarkup(<BridgeProvider demo={false}><Probe /></BridgeProvider>);
    const live = renderToStaticMarkup(
      <BridgeProvider service={service} planner={planner} account="0x123"><Probe /></BridgeProvider>,
    );

    expect(absent).toContain('data-available="no"');
    expect(live).toContain('data-available="yes"');
  });

  it('exposes a recovery service without claiming new-deposit capability', () => {
    const markup = renderToStaticMarkup(
      <BridgeProvider service={{} as never} planner={null} account="0x123"><Probe /></BridgeProvider>,
    );

    expect(markup).toContain('data-service="yes"');
    expect(markup).toContain('data-available="no"');
  });

  it('keeps the production loader dormant until the Bridge surface asks for it', async () => {
    const loadRuntime = vi.fn(async () => ({ service: {} as never, loadSources: async () => [] }));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<BridgeProvider loadRuntime={loadRuntime}><LoadProbe start={false} /></BridgeProvider>);
      await Promise.resolve();
    });
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(container.innerHTML).toContain('data-service="no"');

    await act(async () => root.unmount());
  });

  it('publishes a successful loader result on the first Bridge surface mount', async () => {
    const service = { owner: 'first' } as never;
    const loadRuntime = vi.fn(async () => ({ service, loadSources: async () => [] }));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<BridgeProvider loadRuntime={loadRuntime}><LoadProbe start /></BridgeProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadRuntime).toHaveBeenCalledOnce();
    expect(container.innerHTML).toContain('data-service="yes"');

    await act(async () => root.unmount());
  });

  it('publishes the owned first-mount result after the StrictMode effect probe', async () => {
    const loadRuntime = vi.fn(async () => ({
      service: { owner: 'strict' } as never,
      loadSources: async () => [],
    }));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <BridgeProvider loadRuntime={loadRuntime}><LoadProbe start /></BridgeProvider>
        </StrictMode>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadRuntime).toHaveBeenCalled();
    expect(container.innerHTML).toContain('data-owner="strict"');
    await act(async () => root.unmount());
  });

  it('ignores a deferred result after a replacement loader owns the provider', async () => {
    let resolveFirst!: (value: { service: never; loadSources: () => Promise<never[]> }) => void;
    const first = vi.fn(() => new Promise<{ service: never; loadSources: () => Promise<never[]> }>((resolve) => {
      resolveFirst = resolve;
    }));
    const second = vi.fn(async () => ({
      service: { owner: 'second' } as never,
      loadSources: async () => [],
    }));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<BridgeProvider loadRuntime={first}><LoadProbe start /></BridgeProvider>);
      await Promise.resolve();
    });
    expect(first).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(<BridgeProvider loadRuntime={second}><LoadProbe start /></BridgeProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(second).toHaveBeenCalledOnce();
    expect(container.innerHTML).toContain('data-owner="second"');

    await act(async () => {
      resolveFirst({ service: { owner: 'first' } as never, loadSources: async () => [] });
      await Promise.resolve();
    });
    expect(container.innerHTML).toContain('data-owner="second"');

    await act(async () => root.unmount());
  });

  it('does not resurrect an optional runtime after an explicit service replacement is removed', async () => {
    let resolveFirst!: (value: { service: never; loadSources: () => Promise<never[]> }) => void;
    const first = vi.fn(() => new Promise<{ service: never; loadSources: () => Promise<never[]> }>((resolve) => {
      resolveFirst = resolve;
    }));
    const explicit = { owner: 'explicit' } as never;
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<BridgeProvider loadRuntime={first}><LoadProbe start /></BridgeProvider>);
      await Promise.resolve();
    });
    expect(first).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(<BridgeProvider service={explicit} loadRuntime={first}><LoadProbe start /></BridgeProvider>);
      await Promise.resolve();
    });
    expect(container.innerHTML).toContain('data-owner="explicit"');

    await act(async () => {
      resolveFirst({ service: { owner: 'stale' } as never, loadSources: async () => [] });
      await Promise.resolve();
    });
    expect(container.innerHTML).toContain('data-owner="explicit"');

    await act(async () => {
      root.render(<BridgeProvider loadRuntime={first}><LoadProbe start={false} /></BridgeProvider>);
      await Promise.resolve();
    });
    expect(container.innerHTML).toContain('data-service="no"');
    expect(container.innerHTML).not.toContain('data-owner="stale"');
    await act(async () => root.unmount());
  });

  it('isolates a rejected optional runtime loader from the mounted app', async () => {
    const loadRuntime = vi.fn(async () => { throw new Error('Bridge chunk unavailable'); });
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<BridgeProvider loadRuntime={loadRuntime}><LoadProbe start /></BridgeProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadRuntime).toHaveBeenCalledOnce();
    expect(container.innerHTML).toContain('data-service="no"');
    await act(async () => root.unmount());
  });

  it('releases loader ownership after a synchronous optional-runtime failure', async () => {
    const failed = vi.fn(() => { throw new Error('synchronous chunk failure'); });
    const recovered = vi.fn(async () => ({
      service: { owner: 'recovered' } as never,
      loadSources: async () => [],
    }));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<BridgeProvider loadRuntime={failed as never}><LoadProbe start /></BridgeProvider>);
      await Promise.resolve();
    });
    expect(failed).toHaveBeenCalledOnce();
    expect(container.innerHTML).toContain('data-service="no"');

    await act(async () => {
      root.render(<BridgeProvider loadRuntime={recovered}><LoadProbe start /></BridgeProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(recovered).toHaveBeenCalledOnce();
    expect(container.innerHTML).toContain('data-owner="recovered"');
    await act(async () => root.unmount());
  });
});
