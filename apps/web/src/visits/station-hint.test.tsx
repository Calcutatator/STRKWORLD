import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { BUILDINGS } from '@strkworld/shared';
import { FakePrivacyOperations } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { VisitLayerView } from './VisitLayer.js';
import type { VisitState } from './visit-controller.js';

function render(state: VisitState): string {
  const view: ReactElement = (
    <VisitLayerView
      state={state}
      connected
      onOpenMenu={() => {}}
      onRequestExit={() => {}}
      onCloseSurface={() => {}}
      onDismissLocked={() => {}}
    />
  );
  return renderToStaticMarkup(
    <PrivacyProvider operations={new FakePrivacyOperations()}>{view}</PrivacyProvider>,
  );
}

describe('station hint', () => {
  it('tells the player in every room how stations open, the same way each time', () => {
    for (const building of BUILDINGS) {
      if (building === 'vault') continue; // The Vault is shut; there is no room to be in.
      const markup = render({ name: 'visiting', building, surface: { name: 'room' } });
      expect(markup, building).toContain('class="station-hint"');
      expect(markup, building).toContain(COPY.guide.stationHint);
      expect(markup, building).toContain('role="note"');
    }
    expect(COPY.guide.stationHint).toContain('walk up');
    expect(COPY.guide.stationHint).toContain(COPY.gameMode.menu);
  });

  it('gives way to a window: no hint over a station or Menu Mode', () => {
    const surfaces: VisitState[] = [
      { name: 'visiting', building: 'bank', surface: { name: 'menu' } },
      { name: 'visiting', building: 'bank', surface: { name: 'station', station: 'bank:shielding' } },
      { name: 'locked', building: 'vault', reason: 'coming-soon' },
      { name: 'outside' },
    ];
    for (const state of surfaces) {
      expect(render(state), JSON.stringify(state)).not.toContain('station-hint');
    }
  });
});
