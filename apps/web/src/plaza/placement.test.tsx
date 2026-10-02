import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations, type PlacementCheck } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { COPY } from '../copy.js';
import { ConfirmGate } from '../panels/ConfirmGate.js';
import { PlacementPanelView, type PlacementPhase } from '../panels/plaza/PlacementPanel.js';
import { parseLeaderboard, parseRoutePolicy, placementStandFrom } from '../production/config.js';
import { PRIVACY_REGISTER } from '../privacy/register.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { createViewerStorage, type StorageLike } from '../store/viewer-storage.js';
import { VisitLayerView } from '../visits/VisitLayer.js';
import { resolveStation, stationSnapshot } from '../visits/station-registry.js';
import { PlazaProvider } from './PlazaProvider.js';
import {
  PLACEMENT_STORAGE_KEY,
  placementProgress,
  placementRecord,
  placementView,
  readPlacementRecord,
  writePlacementRecord,
  type PlacementRecord,
} from './placement.js';

/**
 * Leaderboard phase 1, the Shell's side: the placement stand opens its panel
 * (behind the switch), the panel shows the placement worked out on the
 * device, the device keeps four fields and nothing else, and the review
 * step's one quiet line.
 */

/**
 * Vite inlines `import.meta.env`, so `vi.stubEnv` cannot reach
 * `detectPlacementStand()` (see `unshield-route.test.tsx`); the build switch is
 * stood in for here, and `placementStandFrom` covers the environment step.
 */
const stand = vi.hoisted(() => ({ on: false }));
vi.mock('../production/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../production/config.js')>()),
  detectPlacementStand: () => stand.on,
}));

const LEDGER = '0x2ff2a244';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

function check(overrides: Partial<PlacementCheck> = {}): PlacementCheck {
  return {
    season: 's1',
    receipts: 15,
    defi: 3,
    verified: 15,
    histogram: { season: 's1', total: 310, buckets: [{ count: 1, players: 273 }, { count: 15, players: 1 }, { count: 19, players: 36 }] },
    ranked: 15,
    placement: { rank: 37, total: 310, topPercent: 12 },
    ...overrides,
  };
}

function memoryStorage(): { storage: ReturnType<typeof createViewerStorage>; map: Map<string, string> } {
  const map = new Map<string, string>();
  const backing: StorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
  return { storage: createViewerStorage(() => backing), map };
}

afterEach(() => {
  stand.on = false;
});

describe('the placement view, on the device', () => {
  it('shows every private action, the placement and nothing to compare on a first check', () => {
    expect(placementView(check(), null)).toEqual({
      season: 's1',
      count: 18,
      ranked: 15,
      defiOnly: 3,
      placement: { rank: 37, total: 310, topPercent: 12 },
      ranking: true,
      progress: null,
    });
  });

  it('works out the return hook against the last check this season', () => {
    const previous: PlacementRecord = { placement: { rank: 40, total: 300, topPercent: 14 }, count: 12, checkedAt: 1, season: 's1' };
    expect(placementView(check(), previous).progress).toEqual({ newActions: 6, placesUp: 3 });
    expect(placementProgress({ ...previous, placement: { rank: 30, total: 300, topPercent: 10 } }, { placement: check().placement, count: 18, season: 's1' }))
      .toEqual({ newActions: 6, placesUp: -7 });
    expect(placementView(check(), { ...previous, season: 's0' }).progress).toBeNull();
  });

  it('says the ranking is down when there is no histogram', () => {
    expect(placementView(check({ histogram: null, placement: null, verified: null }), null)).toMatchObject({ ranking: false, placement: null });
  });
});

describe('what the device keeps: placement, count, checkedAt, season, and nothing else', () => {
  it('writes exactly the four fields and reads them back', () => {
    const { storage, map } = memoryStorage();
    const view = placementView(check(), null);
    expect(writePlacementRecord(placementRecord(view, 1_790_000_000_000), storage)).toBe(true);
    expect([...map.keys()]).toEqual([PLACEMENT_STORAGE_KEY]);
    expect(Object.keys(JSON.parse(map.get(PLACEMENT_STORAGE_KEY)!)).sort()).toEqual(['checkedAt', 'count', 'placement', 'season']);
    expect(readPlacementRecord(storage)).toEqual({ placement: { rank: 37, total: 310, topPercent: 12 }, count: 18, checkedAt: 1_790_000_000_000, season: 's1' });
  });

  it('reads anything else as a first check', () => {
    const { storage, map } = memoryStorage();
    for (const raw of [
      'not json',
      JSON.stringify({ placement: null, count: 1, checkedAt: 1, season: 's1', partialCommitment: '0x1' }),
      JSON.stringify({ placement: null, count: -1, checkedAt: 1, season: 's1' }),
      JSON.stringify([1, 2]),
    ]) {
      map.set(PLACEMENT_STORAGE_KEY, raw);
      expect(readPlacementRecord(storage), raw).toBeNull();
    }
  });

  it('never throws when the browser refuses storage', () => {
    const throwing = createViewerStorage(() => {
      throw new Error('blocked');
    });
    expect(readPlacementRecord(throwing)).toBeNull();
    expect(writePlacementRecord({ placement: null, count: 0, checkedAt: 0, season: 's1' }, throwing)).toBe(false);
  });
});

describe('the placement panel', () => {
  const render = (phase: PlacementPhase, previous: PlacementRecord | null = null, demo = false) => renderToStaticMarkup(
    <PlacementPanelView phase={phase} previous={previous} demo={demo} onCheck={() => {}} onClose={() => {}} />,
  );

  it('asks first, and says the trust plainly in one line', () => {
    const html = render({ name: 'ready' });
    expect(html).toContain(COPY.plaza.placement.title);
    expect(html).toContain('Check privately');
    expect(html).toContain("Only players who&#x27;ve checked in are ranked. Your account is never stored.");
    expect(html).not.toContain('Top ');
  });

  it('shows the placement, the rank, the count and the return hook', () => {
    const previous: PlacementRecord = { placement: { rank: 40, total: 300, topPercent: 14 }, count: 12, checkedAt: 1, season: 's1' };
    const html = render({ name: 'result', view: placementView(check(), previous) });
    expect(html).toContain('Top 12%');
    expect(html).toContain('Rank about 37 of 310');
    expect(html).toContain('18 private actions');
    expect(html).toContain('+6 since your last check, up 3 places');
    expect(html).toContain('3 DeFi actions count here, on this device, for now.');
    expect(html).toContain(COPY.plaza.placement.saved);
  });

  it('says so when the wallet declined, and labels a demo', () => {
    expect(render({ name: 'refused' })).toContain(COPY.plaza.placement.refused);
    expect(render({ name: 'ready' }, null, true)).toContain(COPY.plaza.placement.demo);
  });
});

describe('the stand opens its panel, behind the switch', () => {
  function renderVisit(): string {
    return renderToStaticMarkup(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <PlazaProvider world={createEventBus<WorldEvents>()} shell={createEventBus<ShellEvents>()} demo>
          <VisitLayerView
            state={{ name: 'plaza', station: 'plaza:placement' }}
            connected={false}
            onOpenMenu={() => {}}
            onRequestExit={() => {}}
            onCloseSurface={() => {}}
            onDismissLocked={() => {}}
          />
        </PlazaProvider>
      </PrivacyProvider>,
    );
  }

  it('opens the placement panel when the switch is on', () => {
    stand.on = true;
    expect(resolveStation('plaza', 'plaza:placement', PRIVACY_REGISTER, {}, null).status).toBe('available');
    const html = renderVisit();
    expect(html).toContain(COPY.plaza.placement.title);
    expect(html).toContain('Check privately');
  });

  it('stays locked with the switch off, and never opens the panel', () => {
    expect(resolveStation('plaza', 'plaza:placement', PRIVACY_REGISTER, {}, null, false).status).toBe('locked');
    expect(renderVisit()).not.toContain(COPY.plaza.placement.title);
    expect(stationSnapshot('plaza', PRIVACY_REGISTER, {}, null).find((entry) => entry.station === 'plaza:placement')?.status).toBe('locked');
  });
});

describe('the build switch', () => {
  const production = { PROD: true, VITE_STRK20_SHIELD_ENABLED: 'true', VITE_STRK20_SHIELD_MAX_INTENTS: '1', VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK };

  it('is off unless exactly true with a contract-address ledger', () => {
    expect(parseLeaderboard({})).toBeNull();
    expect(parseLeaderboard({ VITE_STRK20_LEADERBOARD_ENABLED: 'true' })).toBeNull();
    expect(parseLeaderboard({ VITE_STRK20_LEADERBOARD_LEDGER: LEDGER })).toBeNull();
    expect(parseLeaderboard({ VITE_STRK20_LEADERBOARD_ENABLED: 'TRUE', VITE_STRK20_LEADERBOARD_LEDGER: LEDGER })).toBeNull();
    expect(parseLeaderboard({ VITE_STRK20_LEADERBOARD_ENABLED: 'true', VITE_STRK20_LEADERBOARD_LEDGER: '0x0' })).toBeNull();
    expect(parseLeaderboard({ VITE_STRK20_LEADERBOARD_ENABLED: 'true', VITE_STRK20_LEADERBOARD_LEDGER: `0x8${'0'.repeat(62)}` })).toBeNull();
    expect(parseLeaderboard({ VITE_STRK20_LEADERBOARD_ENABLED: 'true', VITE_STRK20_LEADERBOARD_LEDGER: '0x02ff2a244' })).toEqual({ ledger: LEDGER });
  });

  it('puts the ledger in the route policy only when on, leaving the policy otherwise as it was', () => {
    const off = parseRoutePolicy(production);
    expect(Object.keys(off)).not.toContain('leaderboard');
    expect(parseRoutePolicy({ ...production, VITE_STRK20_LEADERBOARD_LEDGER: LEDGER })).toEqual(off);
    expect(parseRoutePolicy({ ...production, VITE_STRK20_LEADERBOARD_ENABLED: 'true', VITE_STRK20_LEADERBOARD_LEDGER: LEDGER }))
      .toEqual({ ...off, leaderboard: { ledger: LEDGER } });
  });

  it('stands the stand in production only with the whole leaderboard, in a demo with the switch alone', () => {
    expect(placementStandFrom(undefined)).toBe(false);
    expect(placementStandFrom(production)).toBe(false);
    expect(placementStandFrom({ ...production, VITE_STRK20_LEADERBOARD_ENABLED: 'true' })).toBe(false);
    expect(placementStandFrom({ ...production, VITE_STRK20_LEADERBOARD_ENABLED: 'true', VITE_STRK20_LEADERBOARD_LEDGER: LEDGER })).toBe(true);
    expect(placementStandFrom({ DEV: true, VITE_STRK20_LEADERBOARD_ENABLED: 'true' })).toBe(true);
    expect(placementStandFrom({ DEV: true })).toBe(false);
  });
});

describe('the review step\'s quiet line', () => {
  const gate = (countsTowardPlacement?: boolean) => renderToStaticMarkup(
    <ConfirmGate disclosures={[]} requiresDisclosure={false} busy={false} onConfirm={() => {}} onCancel={() => {}}
      {...(countsTowardPlacement === undefined ? {} : { countsTowardPlacement })} />,
  );

  it('says "counts toward your private placement" only when the batch carries a receipt', () => {
    expect(gate(true)).toContain('Counts toward your private placement');
    expect(gate(false)).not.toContain('placement');
    expect(gate()).toBe(gate(false));
  });
});
