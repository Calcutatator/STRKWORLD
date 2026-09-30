import { describe, expect, it, vi } from 'vitest';
import { VESU_POOLS, VESU_PRIME_POOL, VESU_VAULTS, vesuPoolApiUrl, type PinnedVault } from './vault.js';
import {
  VESU_RATES_FAILURE_RETRY_MS,
  VESU_RATES_MAX_BODY_BYTES,
  VESU_RATES_TTL_MS,
  VesuVaultRates,
  parseVesuPoolRates,
} from './vesu-rates.js';

/**
 * D-079, D-081: Vesu's supply APY for the Vault's pinned vaults, read by this
 * service from Vesu's public API, one endpoint per pinned pool, and cached.
 * The fixtures are Vesu's answers cut to the fields read, in Vesu's shape; the
 * figures for Prime's first five are its answer on 2026-09-30.
 */

const RE7_XBTC = '0x03a8416bf20d036df5b1cf3447630a2e1cb04685f6b0c3a70ed7fb1473548ecf';
const RE7_ECOSYSTEM = '0x0486294fe74daf3d964523e7a1f4e5d686f153934b2c183ececa0cab9dd2f3e6';
const byToken = (token: string): PinnedVault => VESU_VAULTS.find((entry) => BigInt(entry.token) === BigInt(token))!;
const STRK = byToken('0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d');
const ETH = byToken('0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7');
const USDC = byToken('0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb');
const STRKBTC = byToken('0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135');
const EKUBO = byToken('0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87');

/** Vesu's live figures for five Prime vaults; every other pinned vault gets a figure made from its place. */
const FIGURES = new Map<string, string>([
  [STRK.vault, '27351899613523568'],
  [ETH.vault, '403060248317937'],
  [USDC.vault, '30925508207480051'],
  [byToken('0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8').vault, '118732256710697075'],
  [byToken('0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac').vault, '3324823423464714'],
]);
const figureOf = (entry: PinnedVault): string => FIGURES.get(entry.vault) ?? String(1_000 + VESU_VAULTS.indexOf(entry));

function asset(address: string, vToken: string, value: unknown, decimals: unknown = 18) {
  return { address, vToken: { address: vToken }, stats: { supplyApy: { value, decimals } } };
}

/** Vesu's answer for one pinned pool: its pinned vaults, and a Vesu asset the Vault does not lend. */
function poolAnswer(pool: string, assets?: unknown[], data: Record<string, unknown> = {}) {
  const listed = assets ?? [
    ...VESU_VAULTS.filter((entry) => BigInt(entry.pool) === BigInt(pool)).map((entry) => asset(entry.token, entry.vault, figureOf(entry))),
    // mRe7BTC-like: a token Vesu lists that the Vault does not pin.
    asset('0x04e4fb1a9ca7e84bae609b9dc0078ad7719e49187ae7e425bb47d131710eddac', '0x013448c4404424a534d22a46330432bd2ef5d884740e8b9fba7f4c273f85ada3', '0'),
  ];
  return { data: { id: pool, isDeprecated: false, name: 'A pool', assets: listed, ...data } };
}

const rateOf = (entry: PinnedVault) => ({ vault: entry.vault, supplyApy: { value: BigInt(figureOf(entry)), decimals: 18 } });
const LIVE_RATES = VESU_VAULTS.map(rateOf);
const ratesOfPool = (pool: string) => VESU_VAULTS.filter((entry) => BigInt(entry.pool) === BigInt(pool)).map(rateOf);

/** A fetch that answers each pinned pool's endpoint with that pool's answer, or with `override` for one pool. */
function vesu(override: Partial<Record<string, () => Response>> = {}) {
  return vi.fn(async (url: string) => {
    const pool = VESU_POOLS.find((candidate) => vesuPoolApiUrl(candidate) === url);
    if (!pool) throw new Error(`unexpected ${url}`);
    const answer = override[pool];
    return answer ? answer() : jsonResponse(poolAnswer(pool));
  });
}

describe('the pinned pools (D-081)', () => {
  it('reads each pool a pinned vault supplies into, once, Prime first', () => {
    expect(VESU_POOLS).toEqual([VESU_PRIME_POOL, RE7_XBTC, RE7_ECOSYSTEM]);
    expect(vesuPoolApiUrl(RE7_XBTC)).toBe(`https://api.vesu.xyz/pools/${RE7_XBTC}`);
    expect(Object.isFrozen(VESU_POOLS)).toBe(true);
  });
});

describe('reading Vesu’s pool answer (D-079, D-081)', () => {
  it('takes the supply APY of each pinned vault in that pool, in pinned order, and nothing else', () => {
    const rates = parseVesuPoolRates(poolAnswer(VESU_PRIME_POOL), VESU_PRIME_POOL);
    expect(rates).toEqual(ratesOfPool(VESU_PRIME_POOL));
    expect(rates.slice(0, 3)).toEqual([
      { vault: STRK.vault, supplyApy: { value: 27351899613523568n, decimals: 18 } },
      { vault: ETH.vault, supplyApy: { value: 403060248317937n, decimals: 18 } },
      { vault: USDC.vault, supplyApy: { value: 30925508207480051n, decimals: 18 } },
    ]);
    expect(Object.isFrozen(rates)).toBe(true);
  });

  it('reads a curated pool’s answer for its own pinned vaults only', () => {
    expect(parseVesuPoolRates(poolAnswer(RE7_XBTC), RE7_XBTC)).toEqual(ratesOfPool(RE7_XBTC));
    expect(parseVesuPoolRates(poolAnswer(RE7_XBTC), RE7_XBTC).map(({ vault }) => vault)).toContain(STRKBTC.vault);
    // A Prime vault's token in a curated pool's answer is not that vault's rate.
    const primeInXbtc = poolAnswer(RE7_XBTC, [asset(STRK.token, STRK.vault, '5')]);
    expect(parseVesuPoolRates(primeInXbtc, RE7_XBTC)).toEqual([]);
  });

  it('matches token and vault by value, whatever their padding', () => {
    const unpadded = (value: string) => `0x${BigInt(value).toString(16)}`;
    expect(parseVesuPoolRates(poolAnswer(VESU_PRIME_POOL, [asset(unpadded(USDC.token), unpadded(USDC.vault).toUpperCase().replace('0X', '0x'), '1')]), VESU_PRIME_POOL))
      .toEqual([{ vault: USDC.vault, supplyApy: { value: 1n, decimals: 18 } }]);
  });

  it.each([
    ['another pool', poolAnswer(VESU_PRIME_POOL, undefined, { id: '0x0123' })],
    ['a curated pool’s answer for Prime', poolAnswer(RE7_XBTC)],
    ['a deprecated pool', poolAnswer(VESU_PRIME_POOL, undefined, { isDeprecated: true })],
    ['no deprecation flag', poolAnswer(VESU_PRIME_POOL, undefined, { isDeprecated: undefined })],
    ['assets that are not a list', poolAnswer(VESU_PRIME_POOL, undefined, { assets: {} })],
    ['more assets than any pool lists', poolAnswer(VESU_PRIME_POOL, Array.from({ length: 129 }, () => asset(STRK.token, STRK.vault, '1')))],
    ['no data', {}],
    ['a list', [poolAnswer(VESU_PRIME_POOL)]],
  ])('refuses %s', (_label, payload) => {
    expect(() => parseVesuPoolRates(payload, VESU_PRIME_POOL)).toThrow();
  });

  it.each([
    ['a null rate', asset(STRK.token, STRK.vault, null)],
    ['a numeric value', asset(STRK.token, STRK.vault, 27)],
    ['a hex value', asset(STRK.token, STRK.vault, '0x1b')],
    ['a negative value', asset(STRK.token, STRK.vault, '-1')],
    ['a decimal-point value', asset(STRK.token, STRK.vault, '0.027')],
    ['a leading zero', asset(STRK.token, STRK.vault, '027')],
    ['a rate of 10,000% or more', asset(STRK.token, STRK.vault, (100n * 10n ** 18n).toString())],
    ['string decimals', asset(STRK.token, STRK.vault, '1', '18')],
    ['fractional decimals', asset(STRK.token, STRK.vault, '1', 1.5)],
    ['too many decimals', asset(STRK.token, STRK.vault, '1', 37)],
    ['the token with another vault', asset(STRK.token, ETH.vault, '1')],
  ])('leaves a vault out for %s', (_label, entry) => {
    expect(parseVesuPoolRates(poolAnswer(VESU_PRIME_POOL, [entry]), VESU_PRIME_POOL)).toEqual([]);
  });

  it('leaves a vault out when two assets name it', () => {
    const twice = [asset(STRK.token, STRK.vault, '1'), asset(STRK.token, STRK.vault, '2')];
    expect(parseVesuPoolRates(poolAnswer(VESU_PRIME_POOL, [...twice, asset(ETH.token, ETH.vault, '3')]), VESU_PRIME_POOL))
      .toEqual([{ vault: ETH.vault, supplyApy: { value: 3n, decimals: 18 } }]);
  });

  it('never runs a getter in the answer', () => {
    let reads = 0;
    const hostile = Object.defineProperty({ address: STRK.token, vToken: { address: STRK.vault } }, 'stats', {
      get() {
        reads += 1;
        return { supplyApy: { value: '1', decimals: 18 } };
      },
      enumerable: true,
    });
    expect(parseVesuPoolRates(poolAnswer(VESU_PRIME_POOL, [hostile]), VESU_PRIME_POOL)).toEqual([]);
    expect(reads).toBe(0);
  });
});

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } });
}

/** A chunked body past the cap that never ends by itself: reading must stop at the cap and cancel it. */
let lastStreamCancelled = false;
function oversizedStream(): Response {
  lastStreamCancelled = false;
  const chunk = new TextEncoder().encode(' '.repeat(64 * 1024));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      lastStreamCancelled = true;
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('the cached Vesu read (D-079, D-081)', () => {
  it('asks each pinned pool’s endpoint once with a GET and no body, and serves one answer for the TTL', async () => {
    let now = 1_000;
    const fetch = vesu();
    const rates = new VesuVaultRates({ fetch, now: () => now });
    await expect(rates.rates()).resolves.toEqual(LIVE_RATES);
    await expect(rates.rates()).resolves.toEqual(LIVE_RATES);
    expect(fetch).toHaveBeenCalledTimes(VESU_POOLS.length);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual(VESU_POOLS.map(vesuPoolApiUrl));
    for (const [, init] of calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(init.body).toBeUndefined();
      expect(JSON.stringify(init.headers)).not.toMatch(/key|auth|cookie/i);
    }

    now += VESU_RATES_TTL_MS;
    await rates.rates();
    expect(fetch).toHaveBeenCalledTimes(VESU_POOLS.length * 2);
  });

  it('refreshes once for callers who ask together', async () => {
    const releases: Array<() => void> = [];
    const fetch = vi.fn((url: string) => new Promise<Response>((resolve) => {
      const pool = VESU_POOLS.find((candidate) => vesuPoolApiUrl(candidate) === url)!;
      releases.push(() => resolve(jsonResponse(poolAnswer(pool))));
    }));
    const rates = new VesuVaultRates({ fetch });
    const first = rates.rates();
    const second = rates.rates();
    await vi.waitFor(() => expect(releases).toHaveLength(VESU_POOLS.length));
    for (const release of releases) release();
    await expect(Promise.all([first, second])).resolves.toEqual([LIVE_RATES, LIVE_RATES]);
    expect(fetch).toHaveBeenCalledTimes(VESU_POOLS.length);
  });

  it.each([
    ['a refusal', () => jsonResponse({ error: 'no' }, { status: 500 })],
    ['a malformed body', () => new Response('not json', { status: 200 })],
    ['another pool', () => jsonResponse(poolAnswer(VESU_PRIME_POOL, undefined, { id: '0x0123' }))],
    ['an oversized declared body', () => jsonResponse(poolAnswer(VESU_PRIME_POOL), { headers: { 'content-length': String(VESU_RATES_MAX_BODY_BYTES + 1) } })],
    ['an oversized body with no declared length', () => oversizedStream()],
    ['an unreachable API', () => { throw new TypeError('fetch failed'); }],
  ])('answers no rates for Prime’s vaults after %s, keeps the other pools’, and asks again after the retry window', async (_label, answer) => {
    let now = 5_000;
    let prime: () => Response = answer;
    const fetch = vesu({ [VESU_PRIME_POOL]: () => prime() });
    const rates = new VesuVaultRates({ fetch, now: () => now });
    const others = LIVE_RATES.filter(({ vault }) => BigInt(VESU_VAULTS.find((entry) => entry.vault === vault)!.pool) !== BigInt(VESU_PRIME_POOL));
    await expect(rates.rates()).resolves.toEqual(others);
    await expect(rates.rates()).resolves.toEqual(others);
    expect(fetch).toHaveBeenCalledTimes(VESU_POOLS.length);
    now += VESU_RATES_FAILURE_RETRY_MS;
    prime = () => jsonResponse(poolAnswer(VESU_PRIME_POOL));
    await expect(rates.rates()).resolves.toEqual(LIVE_RATES);
    expect(fetch).toHaveBeenCalledTimes(VESU_POOLS.length * 2);
  });

  it('answers no rates at all when every pool fails, for the retry window only', async () => {
    let now = 5_000;
    const fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const rates = new VesuVaultRates({ fetch, now: () => now });
    await expect(rates.rates()).resolves.toEqual([]);
    now += VESU_RATES_FAILURE_RETRY_MS - 1;
    await rates.rates();
    expect(fetch).toHaveBeenCalledTimes(VESU_POOLS.length);
    now += 1;
    await rates.rates();
    expect(fetch).toHaveBeenCalledTimes(VESU_POOLS.length * 2);
  });

  it('stops reading an endless body at the cap, and cancels it', async () => {
    const rates = new VesuVaultRates({ fetch: vesu({ [RE7_ECOSYSTEM]: () => oversizedStream() }) });
    const answer = await rates.rates();
    expect(answer.map(({ vault }) => vault)).not.toContain(EKUBO.vault);
    expect(lastStreamCancelled).toBe(true);
  });

  it('gives up on a slow Vesu after its own timeout, with what the other pools answered', async () => {
    const slow = vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      if (url === vesuPoolApiUrl(RE7_XBTC)) {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        return;
      }
      const pool = VESU_POOLS.find((candidate) => vesuPoolApiUrl(candidate) === url)!;
      resolve(jsonResponse(poolAnswer(pool)));
    }));
    const rates = new VesuVaultRates({ fetch: slow, fetchTimeoutMs: 5 });
    const answer = await rates.rates();
    expect(answer.map(({ vault }) => vault)).not.toContain(STRKBTC.vault);
    expect(answer.map(({ vault }) => vault)).toContain(STRK.vault);
  });

  it('lets a caller stop waiting without cancelling the refresh another caller shares', async () => {
    const releases: Array<() => void> = [];
    const fetch = vi.fn((url: string) => new Promise<Response>((resolve) => {
      const pool = VESU_POOLS.find((candidate) => vesuPoolApiUrl(candidate) === url)!;
      releases.push(() => resolve(jsonResponse(poolAnswer(pool))));
    }));
    const rates = new VesuVaultRates({ fetch });
    const controller = new AbortController();
    const leaving = rates.rates(controller.signal);
    const staying = rates.rates();
    controller.abort();
    await expect(leaving).rejects.toBeDefined();
    await vi.waitFor(() => expect(releases).toHaveLength(VESU_POOLS.length));
    for (const release of releases) release();
    await expect(staying).resolves.toEqual(LIVE_RATES);
  });

  it('never asks about a pool no pinned vault names', async () => {
    const onlyStrk = [STRK];
    const fetch = vesu();
    const rates = new VesuVaultRates({ fetch, vaults: onlyStrk });
    await expect(rates.rates()).resolves.toEqual([rateOf(STRK)]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([vesuPoolApiUrl(VESU_PRIME_POOL)]);
  });

  it('refuses a non-positive schedule', () => {
    expect(() => new VesuVaultRates({ ttlMs: 0 })).toThrow(/TTL/);
    expect(() => new VesuVaultRates({ failureRetryMs: -1 })).toThrow(/retry window/);
    expect(() => new VesuVaultRates({ fetchTimeoutMs: 1.5 })).toThrow(/fetch timeout/);
  });
});
