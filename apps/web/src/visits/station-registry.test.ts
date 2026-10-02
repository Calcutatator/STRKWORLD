import { describe, expect, it } from 'vitest';
import type { WalletRoutePolicy } from '@strkworld/privacy';
import { FIXED_ROOM_STATION_ALIASES, fixedRoomDefinitionsFor } from '@strkworld/world';
import { COPY } from '../copy.js';
import { PRIVACY_REGISTER } from '../privacy/register.js';
import { parseRoutePolicy } from '../production/config.js';
import { STATION_ALIASES, canonicalStation, resolveStation, stationDefinition, stationSnapshot } from './station-registry.js';

/**
 * The Bank's and the Vault's counters in the station registry (D-077, D-083,
 * D-085, D-099): one action per counter, each resolved against the register
 * and this build's policy on its own route and switch.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const denyAll: WalletRoutePolicy = {
  maxIntents: 0,
  maxRelayFee: 0n,
  enabledRoutes: [],
  allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
};
const vaultOn: WalletRoutePolicy = {
  ...denyAll,
  maxIntents: 1,
  enabledRoutes: ['vault'],
  allowedTokens: { ...denyAll.allowedTokens, vault: [STRK] },
};
const borrowOn: WalletRoutePolicy = {
  ...vaultOn,
  enabledRoutes: ['vault', 'borrow'],
  allowedTokens: { ...vaultOn.allowedTokens, borrow: [STRK, USDC] },
};

describe('the World and the Shell name the same counters (D-099)', () => {
  it.each(['bank', 'vault'] as const)('publishes the %s room\'s counters in the room\'s order', (building) => {
    const room = fixedRoomDefinitionsFor({ vaultOpen: true }).find((definition) => definition.building === building)!;
    expect(stationSnapshot(building, PRIVACY_REGISTER, {}, null).map(({ station, label }) => ({ station, label }))).toEqual(
      room.stations.map(({ station, label }) => ({ station, label })),
    );
  });

  it('keeps one alias table on both sides: the Vault\'s old lending id now names SUPPLY', () => {
    expect(STATION_ALIASES).toEqual(FIXED_ROOM_STATION_ALIASES);
    expect(Object.isFrozen(STATION_ALIASES)).toBe(true);
    expect(canonicalStation('vault:lending')).toBe('vault:supply');
    expect(canonicalStation('vault:borrow')).toBe('vault:borrow');
    // The old id resolves, and locks, exactly as SUPPLY does.
    expect(resolveStation('vault', 'vault:lending', PRIVACY_REGISTER, {}, vaultOn)).toEqual(
      resolveStation('vault', 'vault:supply', PRIVACY_REGISTER, {}, vaultOn),
    );
    expect(resolveStation('vault', 'vault:lending', PRIVACY_REGISTER, {}, denyAll).status).toBe('locked');
    // But never published: the World only ever hears the current ids.
    expect(stationSnapshot('vault', PRIVACY_REGISTER, {}, vaultOn).map((entry) => entry.station)).not.toContain('vault:lending');
    // An alias never crosses buildings.
    expect(resolveStation('bank', 'vault:lending', PRIVACY_REGISTER, {}, null).definition).toBeNull();
  });
});

describe('the Bank\'s four counters (D-099)', () => {
  it('gives each counter one route and one control, the transfer none of them', () => {
    expect(['bank:shielding', 'bank:unshielding', 'bank:staking', 'bank:unstaking'].map((station) => stationDefinition('bank', station as never))).toEqual([
      expect.objectContaining({ label: 'SHIELD', routes: ['bank.shield'], view: 'bank', modes: ['shield'], initialMode: 'shield' }),
      expect.objectContaining({ label: 'UNSHIELD', routes: ['bank.unshield'], view: 'bank', modes: ['unshield'], initialMode: 'unshield' }),
      expect.objectContaining({ label: 'STAKE', routes: ['bank.stake'], view: 'bank', modes: ['stake'], initialMode: 'stake' }),
      expect.objectContaining({ label: 'UNSTAKE', routes: ['bank.unstake', 'bank.unstake-claim'], view: 'unstake' }),
    ]);
    // The Post Office is the one place to send privately.
    const routes = stationSnapshot('bank', PRIVACY_REGISTER, {}, null).flatMap((entry) => stationDefinition('bank', entry.station)!.routes);
    expect(routes).not.toContain('post-office.transfer');
    expect(stationDefinition('post-office', 'post-office:transfer')).toMatchObject({ routes: ['post-office.transfer'], modes: ['transfer'] });
  });

  it('locks every counter under the production default, each on its own switch', () => {
    const productionDefault = parseRoutePolicy({});
    for (const entry of stationSnapshot('bank', PRIVACY_REGISTER, {}, productionDefault)) {
      const resolution = resolveStation('bank', entry.station, PRIVACY_REGISTER, {}, productionDefault);
      if (resolution.status === 'available') continue;
      expect(resolution.door.reason, entry.station).toBe('not-enabled');
    }
    expect(resolveStation('bank', 'bank:staking', PRIVACY_REGISTER, {}, productionDefault)).toMatchObject({
      status: 'locked',
      door: { message: COPY.locked.notEnabled.stake },
    });
    expect(resolveStation('bank', 'bank:unstaking', PRIVACY_REGISTER, {}, productionDefault)).toMatchObject({
      status: 'locked',
      door: { message: COPY.locked.notEnabled.unstake },
    });
  });

  it('opens UNSTAKE on the unstake switch alone, and STAKE on the stake switch alone', () => {
    const unstakeOnly: WalletRoutePolicy = { ...denyAll, maxIntents: 1, enabledRoutes: ['unstake'] };
    const stakeOnly: WalletRoutePolicy = { ...denyAll, maxIntents: 1, enabledRoutes: ['stake'] };
    const status = (policy: WalletRoutePolicy) =>
      stationSnapshot('bank', PRIVACY_REGISTER, {}, policy).map((entry) => `${entry.station}:${entry.status}`);
    expect(status(unstakeOnly)).toEqual(['bank:shielding:locked', 'bank:unshielding:locked', 'bank:staking:locked', 'bank:unstaking:available']);
    expect(status(stakeOnly)).toEqual(['bank:shielding:locked', 'bank:unshielding:locked', 'bank:staking:available', 'bank:unstaking:locked']);
  });

  it('locks UNSHIELD alone when unshielding loses its approval, leaving SHIELD open', () => {
    const unapproved = PRIVACY_REGISTER.map((entry) => (entry.route === 'bank.unshield' ? { ...entry, approvedBy: null } : entry));
    expect(resolveStation('bank', 'bank:unshielding', unapproved, {}, null)).toMatchObject({ status: 'locked', door: { reason: 'unapproved-route' } });
    expect(resolveStation('bank', 'bank:shielding', unapproved, {}, null).status).toBe('available');
  });

  it('locks UNSTAKE outright if either of its routes loses its approval', () => {
    const unapproved = PRIVACY_REGISTER.map((entry) => (entry.route === 'bank.unstake-claim' ? { ...entry, approvedBy: null } : entry));
    expect(resolveStation('bank', 'bank:unstaking', unapproved, {}, null)).toMatchObject({ status: 'locked', door: { reason: 'unapproved-route' } });
  });
});

describe('the Vault\'s four counters (D-077, D-083, D-099)', () => {
  it('opens SUPPLY and REDEEM, one route each, when the build switches the Vault on', () => {
    expect(resolveStation('vault', 'vault:supply', PRIVACY_REGISTER, {}, vaultOn)).toMatchObject({
      status: 'available',
      definition: { station: 'vault:supply', building: 'vault', label: 'SUPPLY', routes: ['vault.supply'], view: 'vault', mode: 'supply' },
    });
    expect(resolveStation('vault', 'vault:redeem', PRIVACY_REGISTER, {}, vaultOn)).toMatchObject({
      status: 'available',
      definition: { station: 'vault:redeem', label: 'REDEEM', routes: ['vault.redeem'], view: 'vault', mode: 'redeem' },
    });
  });

  it('keeps them locked, saying why, while the build leaves the Vault off', () => {
    for (const station of ['vault:supply', 'vault:redeem'] as const) {
      const resolution = resolveStation('vault', station, PRIVACY_REGISTER, {}, denyAll);
      expect(resolution.status === 'locked' && resolution.door, station).toMatchObject({
        open: false,
        reason: 'not-enabled',
        message: COPY.locked.notEnabled.vault,
      });
    }
  });

  it('locks only the counter whose route loses its approval', () => {
    const unapproved = PRIVACY_REGISTER.map((entry) => (entry.route === 'vault.supply' ? { ...entry, approvedBy: null } : entry));
    expect(resolveStation('vault', 'vault:supply', unapproved, {}, vaultOn).status === 'locked' && resolveStation('vault', 'vault:supply', unapproved, {}, vaultOn)).toMatchObject({
      door: { reason: 'unapproved-route' },
    });
    expect(resolveStation('vault', 'vault:redeem', unapproved, {}, vaultOn).status).toBe('available');
  });

  it('gives BORROW borrowing and adding collateral, and REPAY repaying and withdrawing it, on the one borrow route', () => {
    expect(stationDefinition('vault', 'vault:borrow')).toMatchObject({ label: 'BORROW', routes: ['vault.borrow'], view: 'borrow', modes: ['borrow', 'add-collateral'] });
    expect(stationDefinition('vault', 'vault:repay')).toMatchObject({ label: 'REPAY', routes: ['vault.borrow'], view: 'borrow', modes: ['repay', 'withdraw-collateral'] });
  });

  it('publishes the four counters to the World as presentation only, borrowing behind its own switch', () => {
    expect(stationSnapshot('vault', PRIVACY_REGISTER, {}, vaultOn)).toEqual([
      { station: 'vault:supply', label: 'SUPPLY', status: 'available' },
      { station: 'vault:redeem', label: 'REDEEM', status: 'available' },
      { station: 'vault:borrow', label: 'BORROW', status: 'locked' },
      { station: 'vault:repay', label: 'REPAY', status: 'locked' },
    ]);
    expect(stationSnapshot('vault', PRIVACY_REGISTER, {}, borrowOn).map((entry) => entry.status)).toEqual(['available', 'available', 'available', 'available']);
    expect(stationSnapshot('vault', PRIVACY_REGISTER, {}, denyAll).map((entry) => entry.status)).toEqual(['locked', 'locked', 'locked', 'locked']);
  });

  it('keeps BORROW and REPAY locked, saying why, with borrowing off, and with a list of one token', () => {
    for (const station of ['vault:borrow', 'vault:repay'] as const) {
      const resolution = resolveStation('vault', station, PRIVACY_REGISTER, {}, vaultOn);
      expect(resolution.status === 'locked' && resolution.door, station).toMatchObject({
        open: false,
        reason: 'not-enabled',
        message: COPY.locked.notEnabled.borrow,
      });
      const single = { ...borrowOn, allowedTokens: { ...borrowOn.allowedTokens, borrow: [STRK] } };
      expect(resolveStation('vault', station, PRIVACY_REGISTER, {}, single).status, station).toBe('locked');
    }
  });

  it('locks both borrowing counters outright if their route loses its approval, leaving lending alone', () => {
    const unapproved = PRIVACY_REGISTER.map((entry) => (entry.route === 'vault.borrow' ? { ...entry, approvedBy: null } : entry));
    for (const station of ['vault:borrow', 'vault:repay'] as const) {
      const resolution = resolveStation('vault', station, unapproved, {}, borrowOn);
      expect(resolution.status === 'locked' && resolution.door.reason, station).toBe('unapproved-route');
    }
    expect(resolveStation('vault', 'vault:supply', unapproved, {}, borrowOn).status).toBe('available');
  });

  it('never resolves an unknown Vault station', () => {
    expect(resolveStation('vault', 'vault:loans', PRIVACY_REGISTER, {}, vaultOn).status).toBe('locked');
    expect(stationDefinition('vault', 'vault:loans')).toBeNull();
  });
});
