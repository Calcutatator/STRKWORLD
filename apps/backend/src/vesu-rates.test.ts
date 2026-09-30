import { describe, expect, it, vi } from 'vitest';
import { VESU_PRIME_POOL, VESU_PRIME_POOL_API_URL, VESU_VAULTS } from './vault.js';
import {
  VESU_RATES_FAILURE_RETRY_MS,
  VESU_RATES_MAX_BODY_LENGTH,
  VESU_RATES_TTL_MS,
  VesuVaultRates,
  parseVesuPoolRates,
} from './vesu-rates.js';

/**
 * D-079: Vesu's supply APY for the Vault's pinned vaults, read by this service
 * from Vesu's public API and cached. The fixture is Vesu's answer for the
 * Prime pool on 2026-09-30, cut to the fields read, in Vesu's own order.
 */

const [STRK, ETH, USDC, USDT, WBTC] = VESU_VAULTS;

function asset(address: string, vToken: string, value: unknown, decimals: unknown = 18) {
  return { address, vToken: { address: vToken }, stats: { supplyApy: { value, decimals } } };
}

function primeAnswer(assets: unknown[] = [
  asset(USDC!.token, USDC!.vault, '30925508207480051'),
  // xWBTC and xSTRK: Prime assets the Vault does not lend.
  asset('0x06a567e68c805323525fe1649adb80b03cddf92c23d2629a6779f54192dffc13', '0x00beb129889ac800bb84a8d31dfaa39c8710ee8f6310386ee03a37e79e6d7e1f', '0'),
  asset('0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a', '0x073f369a935c8d8c9c793b371c5d384988060a96e7b11fb1dd2e5718d34639ad', '0'),
  asset(ETH!.token, ETH!.vault, '403060248317937'),
  // The bridged USDC.e, whose own vUSDC is not the pinned one.
  asset('0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8', '0x00079c83c3eb20df05d9e3ebdd45990060101bd126666181de622e432948f3e9', '34222335588994473'),
  asset(USDT!.token, USDT!.vault, '118732256710697075'),
  asset(STRK!.token, STRK!.vault, '27351899613523568'),
  asset(WBTC!.token, WBTC!.vault, '3324823423464714'),
], data: Record<string, unknown> = {}) {
  return { data: { id: VESU_PRIME_POOL, isDeprecated: false, name: 'Prime', assets, ...data } };
}

const LIVE_RATES = [
  { vault: STRK!.vault, supplyApy: { value: 27351899613523568n, decimals: 18 } },
  { vault: ETH!.vault, supplyApy: { value: 403060248317937n, decimals: 18 } },
  { vault: USDC!.vault, supplyApy: { value: 30925508207480051n, decimals: 18 } },
  { vault: USDT!.vault, supplyApy: { value: 118732256710697075n, decimals: 18 } },
  { vault: WBTC!.vault, supplyApy: { value: 3324823423464714n, decimals: 18 } },
];

describe('reading Vesu’s pool answer (D-079)', () => {
  it('takes each pinned vault’s supply APY, in pinned order, and nothing else', () => {
    const rates = parseVesuPoolRates(primeAnswer());
    expect(rates).toEqual(LIVE_RATES);
    expect(Object.isFrozen(rates)).toBe(true);
  });

  it('matches token and vault by value, whatever their padding', () => {
    const unpadded = (value: string) => `0x${BigInt(value).toString(16)}`;
    expect(parseVesuPoolRates(primeAnswer([asset(unpadded(USDC!.token), unpadded(USDC!.vault).toUpperCase().replace('0X', '0x'), '1')])))
      .toEqual([{ vault: USDC!.vault, supplyApy: { value: 1n, decimals: 18 } }]);
  });

  it.each([
    ['another pool', primeAnswer(undefined, { id: '0x0123' })],
    ['a deprecated pool', primeAnswer(undefined, { isDeprecated: true })],
    ['no deprecation flag', primeAnswer(undefined, { isDeprecated: undefined })],
    ['assets that are not a list', primeAnswer(undefined, { assets: {} })],
    ['more assets than any pool lists', primeAnswer(Array.from({ length: 129 }, () => asset(STRK!.token, STRK!.vault, '1')))],
    ['no data', {}],
    ['a list', [primeAnswer()]],
  ])('refuses %s', (_label, payload) => {
    expect(() => parseVesuPoolRates(payload)).toThrow();
  });

  it.each([
    ['a null rate', asset(STRK!.token, STRK!.vault, null)],
    ['a numeric value', asset(STRK!.token, STRK!.vault, 27)],
    ['a hex value', asset(STRK!.token, STRK!.vault, '0x1b')],
    ['a negative value', asset(STRK!.token, STRK!.vault, '-1')],
    ['a decimal-point value', asset(STRK!.token, STRK!.vault, '0.027')],
    ['a leading zero', asset(STRK!.token, STRK!.vault, '027')],
    ['a rate of 10,000% or more', asset(STRK!.token, STRK!.vault, (100n * 10n ** 18n).toString())],
    ['string decimals', asset(STRK!.token, STRK!.vault, '1', '18')],
    ['fractional decimals', asset(STRK!.token, STRK!.vault, '1', 1.5)],
    ['too many decimals', asset(STRK!.token, STRK!.vault, '1', 37)],
    ['the token with another vault', asset(STRK!.token, ETH!.vault, '1')],
  ])('leaves a vault out for %s', (_label, entry) => {
    expect(parseVesuPoolRates(primeAnswer([entry]))).toEqual([]);
  });

  it('leaves a vault out when two assets name it', () => {
    const twice = [asset(STRK!.token, STRK!.vault, '1'), asset(STRK!.token, STRK!.vault, '2')];
    expect(parseVesuPoolRates(primeAnswer([...twice, asset(ETH!.token, ETH!.vault, '3')])))
      .toEqual([{ vault: ETH!.vault, supplyApy: { value: 3n, decimals: 18 } }]);
  });

  it('never runs a getter in the answer', () => {
    let reads = 0;
    const hostile = Object.defineProperty({ address: STRK!.token, vToken: { address: STRK!.vault } }, 'stats', {
      get() {
        reads += 1;
        return { supplyApy: { value: '1', decimals: 18 } };
      },
      enumerable: true,
    });
    expect(parseVesuPoolRates(primeAnswer([hostile]))).toEqual([]);
    expect(reads).toBe(0);
  });
});

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } });
}

describe('the cached Vesu read (D-079)', () => {
  it('asks Vesu’s pinned Prime endpoint with a GET and no body, and serves one answer for the TTL', async () => {
    let now = 1_000;
    const fetch = vi.fn(async () => jsonResponse(primeAnswer()));
    const rates = new VesuVaultRates({ fetch, now: () => now });
    await expect(rates.rates()).resolves.toEqual(LIVE_RATES);
    await expect(rates.rates()).resolves.toEqual(LIVE_RATES);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(VESU_PRIME_POOL_API_URL);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(init.headers)).not.toMatch(/key|auth|cookie/i);

    now += VESU_RATES_TTL_MS;
    await rates.rates();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes once for callers who ask together', async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const rates = new VesuVaultRates({ fetch });
    const first = rates.rates();
    const second = rates.rates();
    release(jsonResponse(primeAnswer()));
    await expect(Promise.all([first, second])).resolves.toEqual([LIVE_RATES, LIVE_RATES]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a refusal', () => jsonResponse({ error: 'no' }, { status: 500 })],
    ['a malformed body', () => new Response('not json', { status: 200 })],
    ['another pool', () => jsonResponse(primeAnswer(undefined, { id: '0x0123' }))],
    ['an oversized declared body', () => jsonResponse(primeAnswer(), { headers: { 'content-length': String(VESU_RATES_MAX_BODY_LENGTH + 1) } })],
    ['an unreachable API', () => { throw new TypeError('fetch failed'); }],
  ])('answers no rates after %s, and asks again only after the retry window', async (_label, answer) => {
    let now = 5_000;
    const fetch = vi.fn(async () => answer());
    const rates = new VesuVaultRates({ fetch, now: () => now });
    await expect(rates.rates()).resolves.toEqual([]);
    await expect(rates.rates()).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += VESU_RATES_FAILURE_RETRY_MS;
    fetch.mockImplementation(async () => jsonResponse(primeAnswer()));
    await expect(rates.rates()).resolves.toEqual(LIVE_RATES);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up on a slow Vesu after its own timeout', async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const rates = new VesuVaultRates({ fetch, fetchTimeoutMs: 5 });
    await expect(rates.rates()).resolves.toEqual([]);
  });

  it('lets a caller stop waiting without cancelling the refresh another caller shares', async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const rates = new VesuVaultRates({ fetch });
    const controller = new AbortController();
    const leaving = rates.rates(controller.signal);
    const staying = rates.rates();
    controller.abort();
    await expect(leaving).rejects.toBeDefined();
    release(jsonResponse(primeAnswer()));
    await expect(staying).resolves.toEqual(LIVE_RATES);
  });

  it('refuses a non-positive schedule', () => {
    expect(() => new VesuVaultRates({ ttlMs: 0 })).toThrow(/TTL/);
    expect(() => new VesuVaultRates({ failureRetryMs: -1 })).toThrow(/retry window/);
    expect(() => new VesuVaultRates({ fetchTimeoutMs: 1.5 })).toThrow(/fetch timeout/);
  });
});
