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
});
