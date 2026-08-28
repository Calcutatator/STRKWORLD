// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BridgeProvider, useBridge } from './BridgeProvider.js';

function Probe() {
  const bridge = useBridge();
  return <p
    data-available={bridge.available() ? 'yes' : 'no'}
    data-service={bridge.service ? 'yes' : 'no'}
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
    const service = {} as never;
    const loadRuntime = vi.fn(async () => ({ service, loadSources: async () => [] }));
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<BridgeProvider loadRuntime={loadRuntime}><LoadProbe start={false} /></BridgeProvider>);
      await Promise.resolve();
    });
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(container.innerHTML).toContain('data-service="no"');

    await act(async () => {
      root.render(<BridgeProvider loadRuntime={loadRuntime}><LoadProbe start /></BridgeProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadRuntime).toHaveBeenCalledOnce();
    expect(container.innerHTML).toContain('data-service="yes"');

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
});
