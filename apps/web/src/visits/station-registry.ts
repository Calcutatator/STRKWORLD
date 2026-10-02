import type { BuildingId, ShellEvents, StationId } from '@strkworld/shared';
import type { WalletRoutePolicy } from '@strkworld/privacy';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { routeDoor, type DoorState } from '../panels/routes.js';
import type { BankMode } from '../panels/bank/bank-machine.js';
import type { VaultMode } from '../panels/vault/vault-machine.js';
import type { BorrowMode } from '../panels/borrow/borrow-machine.js';
import { COPY } from '../copy.js';
import { detectRoutePolicy } from '../production/config.js';

/**
 * A Bank-machine counter: one control each (D-103), so `modes` holds exactly
 * one mode and `initialMode` is it. The Post Office's TRANSFER is one too.
 */
type BankStationDefinition = {
  station: StationId; building: BuildingId; label: string; routes: readonly string[];
  view: 'bank'; modes: readonly [BankMode]; initialMode: BankMode;
};
/**
 * The Bank's UNSTAKE counter (D-085, D-103): Endur's request, the pending
 * requests and the claim, behind the two unstaking routes, which one policy
 * route (`unstake`) gates together, so the station keeps one grade (D-030).
 */
type UnstakeStationDefinition = {
  station: StationId; building: 'bank'; label: string; routes: readonly string[];
  view: 'unstake';
};
type ExchangeStationDefinition = {
  station: StationId; building: 'exchange'; label: string; routes: readonly string[];
  view: 'exchange';
  /** The ground floor's six-asset swap (D-042), or the degen floor's list (D-067). */
  mode: 'ground' | 'degen';
};
type BridgeStationDefinition = {
  station: StationId; building: 'bridge'; label: string; routes: readonly string[];
  view: 'bridge';
};
/**
 * The Vault's lending counters (D-077, D-103): SUPPLY and REDEEM, one route
 * and one action each, both `anonymous` in the register (D-030).
 */
type VaultStationDefinition = {
  station: StationId; building: 'vault'; label: string; routes: readonly string[];
  view: 'vault'; mode: VaultMode;
};
/**
 * The borrowing counters (D-083, D-103): Vesu loans from a second shadow
 * account. BORROW borrows and adds collateral; REPAY repays and withdraws
 * collateral. Both drive the one `vault.borrow` route, whose grade entry and
 * disclosure (liquidation) are its own, so no station mixes them (D-030).
 */
type BorrowStationDefinition = {
  station: StationId; building: 'vault'; label: string; routes: readonly string[];
  view: 'borrow'; modes: readonly [BorrowMode, ...BorrowMode[]];
};
/**
 * The Privacy Plaza's two windows (D-076). No money and no route: `routes`
 * is empty on purpose, so nothing here reaches the privacy register, and
 * the plaza needs no wallet. The station still resolves here before its
 * window opens, and an unknown plaza id stays locked.
 */
type PlazaStationDefinition = {
  station: StationId; building: 'plaza'; label: string; routes: readonly [];
  view: 'plaza-monument' | 'plaza-shells';
};

/**
 * Shell-owned meaning for an opaque station id.
 *
 * None of this crosses into Phaser. The World receives only the preformatted
 * label and lock state; routes, modes and privacy grades stay here with the
 * financial controls they admit (D-033).
 */
export type StationDefinition =
  | BankStationDefinition
  | UnstakeStationDefinition
  | ExchangeStationDefinition
  | BridgeStationDefinition
  | VaultStationDefinition
  | BorrowStationDefinition
  | PlazaStationDefinition;

export interface StationCapabilities {
  /** The account reader is deliberately coarse: the World only gets a lock bit. */
  bridgeAccountAvailable?: boolean;
  bridgePlannerAvailable?: boolean;
}

function freezeStationDefinition(definition: StationDefinition): StationDefinition {
  Object.freeze(definition.routes);
  if ('modes' in definition) Object.freeze(definition.modes);
  return Object.freeze(definition);
}

/**
 * Station ids an earlier build used, and the counter each now names (D-103).
 * Only the Vault's lending counter was renamed (`vault:lending` held supply
 * and redeem; SUPPLY keeps its place in the room), so an id from a stale
 * World or an old debug log still resolves to a counter that exists. The
 * World keeps the same table (`FIXED_ROOM_STATION_ALIASES`).
 */
export const STATION_ALIASES: Readonly<Partial<Record<StationId, StationId>>> = Object.freeze({
  'vault:lending': 'vault:supply',
});

/** The current id for a station: itself, or the counter a renamed id now names. */
export function canonicalStation(station: StationId): StationId {
  return STATION_ALIASES[station] ?? station;
}

const STATIONS: readonly StationDefinition[] = Object.freeze([
  // D-103: the Bank's four counters, one action each, west to east. Shielding
  // and unshielding are `public-edge`; staking (D-063) and unstaking (D-085)
  // their own Endur routes. No station mixes grades (D-030), and each locks
  // on its own route and switch.
  {
    station: 'bank:shielding',
    building: 'bank',
    label: 'SHIELD',
    routes: ['bank.shield'],
    modes: ['shield'],
    initialMode: 'shield',
    view: 'bank',
  },
  {
    station: 'bank:unshielding',
    building: 'bank',
    label: 'UNSHIELD',
    routes: ['bank.unshield'],
    modes: ['unshield'],
    initialMode: 'unshield',
    view: 'bank',
  },
  {
    station: 'bank:staking',
    building: 'bank',
    label: 'STAKE',
    routes: ['bank.stake'],
    modes: ['stake'],
    initialMode: 'stake',
    view: 'bank',
  },
  {
    station: 'bank:unstaking',
    building: 'bank',
    label: 'UNSTAKE',
    routes: ['bank.unstake', 'bank.unstake-claim'],
    view: 'unstake',
  },
  {
    station: 'post-office:transfer',
    building: 'post-office',
    label: 'TRANSFER',
    routes: ['post-office.transfer'],
    modes: ['transfer'],
    initialMode: 'transfer',
    view: 'bank',
  },
  {
    station: 'exchange:swap',
    building: 'exchange',
    label: 'SWAP',
    routes: ['exchange.swap'],
    view: 'exchange',
    mode: 'ground',
  },
  // The Exchange tower's degen floor (D-067): the same `exchange.swap` route,
  // grade and disclosure as the counter downstairs, so it opens and locks
  // exactly when that one does; only its token list differs.
  {
    station: 'exchange:degen',
    building: 'exchange',
    label: 'DEGEN SWAP',
    routes: ['exchange.swap'],
    view: 'exchange',
    mode: 'degen',
  },
  {
    station: 'bridge:deposit',
    building: 'bridge',
    label: 'DEPOSIT',
    routes: ['bridge.deposit'],
    view: 'bridge',
  },
  // The Vault (D-077): Vesu lending from the player's shadow account, one
  // action per counter (D-103). The room exists only when this build switches
  // both lending routes on; otherwise the World keeps the door locked and the
  // player never reaches these counters.
  {
    station: 'vault:supply',
    building: 'vault',
    label: 'SUPPLY',
    routes: ['vault.supply'],
    view: 'vault',
    mode: 'supply',
  },
  {
    station: 'vault:redeem',
    building: 'vault',
    label: 'REDEEM',
    routes: ['vault.redeem'],
    view: 'vault',
    mode: 'redeem',
  },
  // D-083: borrowing, behind its own switch (`VITE_STRK20_BORROW_ENABLED`).
  // With the Vault open and borrowing off, both counters stand locked and say so.
  {
    station: 'vault:borrow',
    building: 'vault',
    label: 'BORROW',
    routes: ['vault.borrow'],
    view: 'borrow',
    modes: ['borrow', 'add-collateral'],
  },
  {
    station: 'vault:repay',
    building: 'vault',
    label: 'REPAY',
    routes: ['vault.borrow'],
    view: 'borrow',
    modes: ['repay', 'withdraw-collateral'],
  },
  // The Privacy Plaza (D-076): its stations stand on the street, and open
  // with E. Client-only windows with no route, so no privacy grade applies.
  {
    station: 'plaza:monument',
    building: 'plaza',
    label: 'POOL STATS',
    routes: [],
    view: 'plaza-monument',
  },
  {
    station: 'plaza:shells',
    building: 'plaza',
    label: "WHERE'S THE NOTE?",
    routes: [],
    view: 'plaza-shells',
  },
] as const).map((definition) => freezeStationDefinition(definition));

/**
 * A station's meaning, without admitting it: what its window is and what it
 * does. Never an authorization; `resolveStation` decides whether it opens.
 */
export function stationDefinition(building: BuildingId, station: StationId): StationDefinition | null {
  const id = canonicalStation(station);
  return STATIONS.find((candidate) => candidate.building === building && candidate.station === id) ?? null;
}

export type StationResolution =
  | { status: 'available'; definition: StationDefinition }
  | { status: 'locked'; definition: StationDefinition | null; door: DoorState };

/**
 * Resolve again at the interaction boundary. A World snapshot is presentation,
 * never authorization, and an unknown id is always a locked result. A renamed
 * id resolves as the counter it now names (`STATION_ALIASES`, D-103).
 *
 * A station can bundle more than one route — `bank:unstaking` is the unstake
 * request and its claim behind one door. Those two gates disagree in how a locked
 * constituent route should behave: an unapproved or unknown route (the
 * privacy register's business) is a hard stop for the whole station, because
 * an unapproved deviation must never be reachable through a sibling control
 * that happens to be fine. A route the active wallet policy simply has not
 * switched on (D-054/D-056) is softer — that is this deployment's own choice,
 * expected to vary per route (shield enabled while unshield stays off, say;
 * D-062 lets a build switch unshield on too), and the panel behind an
 * otherwise-open station already renders that one control as locked on its
 * own (`BankPanel`'s `ModeTabs`). So the station only locks outright on a
 * policy reason when *every* route it offers is unavailable — there is nothing
 * left inside worth opening the door for.
 */
export function resolveStation(
  building: BuildingId,
  station: StationId,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
  capabilities: StationCapabilities = {},
  policy: WalletRoutePolicy | null = detectRoutePolicy(),
): StationResolution {
  const definition = stationDefinition(building, station);
  if (!definition) {
    return {
      status: 'locked',
      definition: null,
      door: routeDoor('__unknown_station__', register, policy),
    };
  }

  // The plaza's windows move no money and take no route (D-076): once the id
  // resolves, they open.
  if (definition.building === 'plaza') return { status: 'available', definition };

  const doors = definition.routes.map((route) => routeDoor(route, register, policy));
  const hardLock = doors.find((door) => !door.open && door.reason !== 'not-enabled');
  if (hardLock) return { status: 'locked', definition, door: hardLock };
  if (doors.every((door) => !door.open)) {
    return { status: 'locked', definition, door: doors[0]! };
  }
  if (
    definition.view === 'bridge' &&
    (!capabilities.bridgeAccountAvailable || !capabilities.bridgePlannerAvailable)
  ) {
    return {
      status: 'locked',
      definition,
      door: { open: false, reason: 'capability-unavailable', message: COPY.bridge.unavailable },
    };
  }
  return { status: 'available', definition };
}

/** Presentation-only data sent to the World. Omitted and unknown means locked. */
export function stationSnapshot(
  building: BuildingId,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
  capabilities: StationCapabilities = {},
  policy: WalletRoutePolicy | null = detectRoutePolicy(),
): ShellEvents['world:stations']['stations'] {
  return Object.freeze(STATIONS.filter((station) => station.building === building).map((definition) => Object.freeze({
    station: definition.station,
    label: definition.label,
    status: resolveStation(building, definition.station, register, capabilities, policy).status,
  })));
}
