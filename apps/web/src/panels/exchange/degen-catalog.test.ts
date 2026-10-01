// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { WalletRoutePolicy } from '@strkworld/privacy';
import { DEMO_DEGEN_CATALOG, DEMO_DEGEN_RATES } from '../../privacy/demo-degen.js';
import { parseRoutePolicy } from '../../production/config.js';
import {
  DEGEN_BASE_ASSET,
  createBackendDegenCatalog,
  degenExchangeAssets,
  degenExchangeCatalog,
  parseDegenCatalogResponse,
  policyAdmitsSwapToken,
  type DegenCatalogSnapshot,
} from './degen-catalog.js';

/**
 * The Shell's half of D-067's degen list: read the backend's list strictly,
 * put STRK first, and mark every token this build cannot swap as display
 * only. The backend and the wallet policy stay the authority.
 */

const STRK = DEGEN_BASE_ASSET.token;
const LORDS = '0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49';
const DREAMS = '0x04fcaf2a7b4a072fe57c59beee807322d34ed65000d78611c909a46fead07fb1';
const EKUBO = '0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87';

function token(overrides: Record<string, unknown> = {}) {
  return { address: LORDS, symbol: 'LORDS', name: 'Lords', decimals: 18, tags: ['Verified', 'AVNU'], curated: true, ...overrides };
}

function response(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json' } });
}

describe('the backend degen list client', () => {
  it('makes one same-origin GET that carries nothing, and reads the list', async () => {
    const fetch = vi.fn(async () => response({ source: 'live', tokens: [token(), token({ address: EKUBO, symbol: 'EKUBO', name: 'Ekubo Protocol', curated: false })] }));
    const source = createBackendDegenCatalog({ baseUrl: '/api', fetch });

    const snapshot = await source.load();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/degen/tokens');
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer' });
    expect(init.body).toBeUndefined();
    expect(snapshot).toEqual({
      origin: 'live',
      listings: [
        { token: LORDS, symbol: 'LORDS', name: 'Lords', decimals: 18, tags: ['Verified', 'AVNU'], curated: true },
        { token: EKUBO, symbol: 'EKUBO', name: 'Ekubo Protocol', decimals: 18, tags: ['Verified', 'AVNU'], curated: false },
      ],
    });
  });

  it('passes cancellation through and refuses a failed response', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => response({ code: 'HTTP_503', message: 'Degen mode is disabled.' }, { status: 503 }));
    await expect(createBackendDegenCatalog({ baseUrl: '/api', fetch }).load(controller.signal))
      .rejects.toThrow('The degen list is unavailable.');
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(controller.signal);
  });

  it('reads only from a same-origin path', () => {
    for (const baseUrl of ['https://api.example', '//api.example', 'api', '']) {
      expect(() => createBackendDegenCatalog({ baseUrl, fetch: vi.fn() })).toThrow('same-origin');
    }
  });

  it('says when avnu was unreachable and only the curated core came back', async () => {
    const snapshot = parseDegenCatalogResponse({ source: 'curated', tokens: [token()] });
    expect(snapshot.origin).toBe('curated');
  });

  it('never carries anything but the six fields it shows', () => {
    const snapshot = parseDegenCatalogResponse({
      source: 'live',
      tokens: [token({ logoUri: 'https://tracker.example/pixel.png', lastDailyVolumeUsd: 5, extensions: { x: 'y' } })],
      extra: 'ignored',
    });
    expect(Object.keys(snapshot.listings[0]!).sort()).toEqual(['curated', 'decimals', 'name', 'symbol', 'tags', 'token']);
    expect(JSON.stringify(snapshot)).not.toContain('tracker');
  });

  it.each([
    ['a non-object body', 'tokens'],
    ['an unknown source', { source: 'avnu', tokens: [token()] }],
    ['no tokens', { source: 'live', tokens: [] }],
    ['tokens that are not an array', { source: 'live', tokens: {} }],
    ['too many tokens', { source: 'live', tokens: Array.from({ length: 129 }, (_, index) => token({ address: `0x${(index + 1).toString(16)}`, symbol: `T${index}` })) }],
    ['a repeated address', { source: 'live', tokens: [token(), token({ address: '0x124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49', symbol: 'OTHER' })] }],
    ['a malformed address', { source: 'live', tokens: [token({ address: 'lords' })] }],
    ['a zero address', { source: 'live', tokens: [token({ address: '0x0' })] }],
    ['an out-of-field address', { source: 'live', tokens: [token({ address: `0x${'f'.repeat(64)}` })] }],
    ['a look-alike symbol', { source: 'live', tokens: [token({ symbol: 'LОRDS' })] }],
    ['an over-long symbol', { source: 'live', tokens: [token({ symbol: 'L'.repeat(17) })] }],
    ['a symbol with no letter or digit', { source: 'live', tokens: [token({ symbol: '$$' })] }],
    ['a bidirectional-override name', { source: 'live', tokens: [token({ name: 'Lords ‮' })] }],
    ['a fractional decimals', { source: 'live', tokens: [token({ decimals: 1.5 })] }],
    ['negative decimals', { source: 'live', tokens: [token({ decimals: -1 })] }],
    ['an unknown tag', { source: 'live', tokens: [token({ tags: ['Verified', 'Safe'] })] }],
    ['a repeated tag', { source: 'live', tokens: [token({ tags: ['Verified', 'Verified'] })] }],
    ['a non-boolean curated flag', { source: 'live', tokens: [token({ curated: 'yes' })] }],
  ])('fails the whole list on %s', (_label, body) => {
    expect(() => parseDegenCatalogResponse(body)).toThrow('The degen list response is malformed.');
  });

  it('never runs an accessor in the response', () => {
    const read = vi.fn(() => 'LORDS');
    const hostile = token();
    delete (hostile as Record<string, unknown>).symbol;
    Object.defineProperty(hostile, 'symbol', { get: read, enumerable: true });
    expect(() => parseDegenCatalogResponse({ source: 'live', tokens: [hostile] })).toThrow('malformed');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('what this build can swap', () => {
  it('restricts nothing without a production policy, as the demo and tests have none', () => {
    expect(policyAdmitsSwapToken(null, LORDS)).toBe(true);
  });

  it('admits nothing under the default production policy, which enables no swap', () => {
    const production = parseRoutePolicy({});
    expect(policyAdmitsSwapToken(production, STRK)).toBe(false);
    expect(policyAdmitsSwapToken(production, LORDS)).toBe(false);
  });

  it('admits exactly the swap tokens a swap-enabled policy names', () => {
    const policy: WalletRoutePolicy = {
      maxIntents: 1,
      maxRelayFee: 5n,
      enabledRoutes: ['swap'],
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [STRK, LORDS] },
      swap: { expectedChainId: '0x534e5f4d41494e', slippageBps: 50 },
    };
    expect(policyAdmitsSwapToken(policy, '0x124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49')).toBe(true);
    expect(policyAdmitsSwapToken(policy, DREAMS)).toBe(false);
    expect(policyAdmitsSwapToken({ ...policy, enabledRoutes: [] }, LORDS)).toBe(false);
    expect(policyAdmitsSwapToken({ enabledRoutes: null } as unknown as WalletRoutePolicy, LORDS)).toBe(false);
  });

  it('admits every listed token under a policy with the degen switch on, and none with swap off (D-084)', () => {
    const policy = parseRoutePolicy({
      VITE_STRK20_SWAP_ENABLED: 'true',
      VITE_STRK20_SWAP_ALLOWED_TOKENS: STRK,
      VITE_STRK20_SWAP_SLIPPAGE_BPS: '50',
      VITE_STRK20_SWAP_DEGEN_ENABLED: 'true',
    });
    expect(policyAdmitsSwapToken(policy, DREAMS)).toBe(true);
    expect(policyAdmitsSwapToken(policy, EKUBO)).toBe(true);
    expect(policyAdmitsSwapToken({ ...policy, enabledRoutes: [] }, DREAMS)).toBe(false);
    const ground = parseRoutePolicy({
      VITE_STRK20_SWAP_ENABLED: 'true',
      VITE_STRK20_SWAP_ALLOWED_TOKENS: STRK,
      VITE_STRK20_SWAP_SLIPPAGE_BPS: '50',
    });
    expect(policyAdmitsSwapToken(ground, STRK)).toBe(true);
    expect(policyAdmitsSwapToken(ground, DREAMS)).toBe(false);
  });
});

describe('the degen floor\'s assets', () => {
  const snapshot: DegenCatalogSnapshot = parseDegenCatalogResponse({
    source: 'live',
    tokens: [
      token(),
      token({ address: DREAMS, symbol: 'DREAMS', name: 'Daydreams', decimals: 6, tags: ['Verified', 'Community'] }),
      token({ address: EKUBO, symbol: 'EKUBO', name: 'Ekubo Protocol', curated: false }),
    ],
  });

  it('lists STRK first, whatever the list holds, then the list in its own order', () => {
    const assets = degenExchangeAssets(snapshot, () => true);
    expect(assets.map((asset) => asset.symbol)).toEqual(['STRK', 'LORDS', 'DREAMS', 'EKUBO']);
    expect(assets[0]).toMatchObject({ token: STRK, decimals: 18, name: 'Starknet', swappable: true });
    expect(assets[2]).toMatchObject({ token: DREAMS, decimals: 6, tags: ['Verified', 'Community'], swappable: true });
    expect(Object.isFrozen(assets)).toBe(true);
    expect(Object.isFrozen(assets[1]!.tags)).toBe(true);
  });

  it('shows a token this build cannot swap as display only', () => {
    const assets = degenExchangeAssets(snapshot, (candidate) => BigInt(candidate) === BigInt(STRK) || BigInt(candidate) === BigInt(LORDS));
    expect(assets.map((asset) => [asset.symbol, asset.swappable])).toEqual([
      ['STRK', true], ['LORDS', true], ['DREAMS', false], ['EKUBO', false],
    ]);
    // A policy that throws admits nothing.
    expect(degenExchangeAssets(snapshot, () => { throw new Error('hostile'); }).every((asset) => asset.swappable === false)).toBe(true);
  });

  it('keeps the first of two entries for one address or one ticker', () => {
    const squatted = parseDegenCatalogResponse({
      source: 'live',
      tokens: [
        token({ address: '0x0bad', symbol: 'strk', name: 'Not Starknet', curated: false }),
        token(),
        token({ address: '0x0bad2', symbol: 'L.O.R.D.S', name: 'Not Lords', curated: false }),
      ],
    });
    expect(degenExchangeAssets(squatted, () => true).map((asset) => asset.token)).toEqual([STRK, LORDS]);
  });

  it('marks a token the demo seam cannot quote as display only', async () => {
    const assets = degenExchangeAssets(await DEMO_DEGEN_CATALOG.load(), () => true);
    expect(assets.filter((asset) => asset.swappable === false).map((asset) => asset.symbol)).toEqual(['SSTR']);
  });

  it('fails when the build has no list, rather than inventing one', async () => {
    await expect(degenExchangeCatalog(null, () => true).load()).rejects.toThrow('This build has no degen list.');
  });
});

describe('the demo list', () => {
  it('is the backend\'s pinned curated core plus two live stand-ins, flagged as the demo', async () => {
    const snapshot = await DEMO_DEGEN_CATALOG.load();
    expect(snapshot.origin).toBe('demo');
    expect(snapshot.listings.map((listing) => [listing.symbol, listing.curated])).toEqual([
      ['LORDS', true], ['DREAMS', true], ['SLAY', true], ['BROTHER', true], ['tBTC', true], ['CASH', true], ['DOG', true],
      ['EKUBO', false], ['SSTR', false],
    ]);
    // Every curated address and decimals must be the backend's own pin.
    const backend = readFileSync(new URL('../../../../backend/src/degen-catalog.ts', import.meta.url), 'utf8');
    for (const listing of snapshot.listings.filter((entry) => entry.curated)) {
      const pinned = new RegExp(`address: '${listing.token}',\\s*decimals: ${listing.decimals},`);
      expect(backend, listing.symbol).toMatch(pinned);
    }
  });

  it('has a DEMO rate for every quotable listing and for STRK, and none for the display-only one', async () => {
    const snapshot = await DEMO_DEGEN_CATALOG.load();
    const rated = new Set(Object.keys(DEMO_DEGEN_RATES).map((address) => BigInt(address)));
    expect(rated.has(BigInt(STRK))).toBe(true);
    for (const listing of snapshot.listings) {
      expect(rated.has(BigInt(listing.token)), listing.symbol).toBe(listing.quotable !== false);
    }
    // Round powers of ten, so no demo rate can pass for a price.
    for (const rate of Object.values(DEMO_DEGEN_RATES)) expect(rate.toString()).toMatch(/^10*$/);
  });
});
