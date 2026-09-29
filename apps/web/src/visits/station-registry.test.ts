import { describe, expect, it } from 'vitest';
import type { WalletRoutePolicy } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { PRIVACY_REGISTER } from '../privacy/register.js';
import { resolveStation, stationSnapshot } from './station-registry.js';

/**
 * The Vault's counter in the station registry (D-077): the Shell's meaning
 * for `vault:lending`, resolved against the register and this build's policy.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
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

describe('the Vault counter station (D-077)', () => {
  it('opens the lending counter, with both routes, when the build switches the Vault on', () => {
    const resolution = resolveStation('vault', 'vault:lending', PRIVACY_REGISTER, {}, vaultOn);
    expect(resolution.status).toBe('available');
    expect(resolution.definition).toMatchObject({
      station: 'vault:lending',
      building: 'vault',
      label: 'SUPPLY / REDEEM',
      routes: ['vault.supply', 'vault.redeem'],
      view: 'vault',
    });
  });

  it('keeps it locked, saying why, while the build leaves the Vault off', () => {
    const resolution = resolveStation('vault', 'vault:lending', PRIVACY_REGISTER, {}, denyAll);
    expect(resolution.status).toBe('locked');
    expect(resolution.status === 'locked' && resolution.door).toMatchObject({
      open: false,
      reason: 'not-enabled',
      message: COPY.locked.notEnabled.vault,
    });
  });

  it('keeps it locked outright if either route loses its approval', () => {
    const unapproved = PRIVACY_REGISTER.map((entry) =>
      entry.route === 'vault.supply' ? { ...entry, approvedBy: null } : entry);
    const resolution = resolveStation('vault', 'vault:lending', unapproved, {}, vaultOn);
    expect(resolution.status === 'locked' && resolution.door.reason).toBe('unapproved-route');
  });

  it('publishes the counter to the World as presentation only', () => {
    expect(stationSnapshot('vault', PRIVACY_REGISTER, {}, vaultOn)).toEqual([
      { station: 'vault:lending', label: 'SUPPLY / REDEEM', status: 'available' },
    ]);
    expect(stationSnapshot('vault', PRIVACY_REGISTER, {}, denyAll)).toEqual([
      { station: 'vault:lending', label: 'SUPPLY / REDEEM', status: 'locked' },
    ]);
  });

  it('never resolves an unknown Vault station', () => {
    expect(resolveStation('vault', 'vault:borrow', PRIVACY_REGISTER, {}, vaultOn).status).toBe('locked');
  });
});
