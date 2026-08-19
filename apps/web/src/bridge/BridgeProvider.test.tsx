import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BridgeProvider, useBridge } from './BridgeProvider.js';

function Probe() {
  const bridge = useBridge();
  return <p data-available={bridge.available() ? 'yes' : 'no'}>{bridge.account ?? 'none'}</p>;
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
});
