import { useState, type ReactNode } from 'react';
import type { WalletRoutePolicy } from '@strkworld/privacy';
import type { BuildingId, StationId } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { detectRoutePolicy } from '../production/config.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { resolveStation, type StationDefinition } from '../visits/station-registry.js';

/**
 * Menu Mode's counter switch (D-088).
 *
 * A building whose Game Mode room holds more than one window (the Bank's
 * SHIELD, UNSHIELD, STAKE and UNSTAKE and the Vault's SUPPLY, REDEEM, BORROW
 * and REPAY since D-099, the Exchange's SWAP and DEGEN SWAP) shows the
 * same windows in Menu Mode, one at a time, behind a row of tabs named as the
 * counters are. Each tab is admitted exactly as its counter is: by
 * `resolveStation`, against the same register, policy and build switches, so
 * a counter the build leaves off is not offered here either. The first
 * counter is the building's own Menu Mode window and is always offered; the
 * window behind it still shows its own locked door.
 *
 * Only the chosen window is mounted, so only one confirm is ever on screen.
 * Switching tabs closes one window and opens the other, exactly as walking
 * from one counter to the next does; a submission already sent is not
 * cancelled by it, and its receipt survives in the shared ledger.
 */

export interface MenuCounter {
  readonly station: StationId;
  readonly label: string;
}

/**
 * The counters Menu Mode offers in `building`: the first always, then each
 * other one only while its Game Mode counter would open.
 */
export function menuCounters(
  building: BuildingId,
  stations: readonly [StationId, ...StationId[]],
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
  policy: WalletRoutePolicy | null = detectRoutePolicy(),
): readonly MenuCounter[] {
  const [first, ...rest] = stations;
  const counters: MenuCounter[] = [];
  const label = (definition: StationDefinition | null, station: StationId) => definition?.label ?? station;
  counters.push({ station: first, label: label(resolveStation(building, first, register, {}, policy).definition, first) });
  for (const station of rest) {
    const resolution = resolveStation(building, station, register, {}, policy);
    if (resolution.status === 'available') counters.push({ station, label: resolution.definition.label });
  }
  return Object.freeze(counters.map((counter) => Object.freeze(counter)));
}

/**
 * Which counter is showing, and the tabs that switch it. With one counter
 * there are no tabs: the building's Menu Mode window is exactly what it was.
 */
export function useMenuCounter(counters: readonly MenuCounter[]): {
  active: StationId;
  tabs: ReactNode;
} {
  const [chosen, setChosen] = useState<StationId>(counters[0]!.station);
  // A counter that stopped being offered falls back to the first.
  const active = counters.some((counter) => counter.station === chosen) ? chosen : counters[0]!.station;
  const tabs = counters.length > 1
    ? <MenuCounterTabs counters={counters} active={active} onSelect={setChosen} />
    : null;
  return { active, tabs };
}

export function MenuCounterTabs({
  counters,
  active,
  onSelect,
}: {
  counters: readonly MenuCounter[];
  active: StationId;
  onSelect: (station: StationId) => void;
}) {
  return (
    <nav className="panel-modes menu-counters" role="tablist" aria-label={COPY.gameMode.counters}>
      {counters.map((counter) => (
        <button
          key={counter.station}
          type="button"
          role="tab"
          aria-selected={counter.station === active}
          data-station={counter.station}
          onClick={() => onSelect(counter.station)}
        >
          {counter.label}
        </button>
      ))}
    </nav>
  );
}
