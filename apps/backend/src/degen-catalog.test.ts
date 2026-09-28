import { describe, expect, it, vi } from 'vitest';
import {
  AVNU_TOKEN_MAX_PAGES,
  AVNU_TOKEN_PAGE_SIZE,
  AvnuDegenCatalog,
  DEGEN_FAILURE_RETRY_MS,
  type AvnuDegenCatalogOptions,
} from './avnu-degen-catalog.js';
import {
  CURATED_ONLY_SNAPSHOT,
  DEGEN_CURATED_CORE,
  DEGEN_MAX_LIVE_TOKENS,
  degenSnapshot,
  filterLiveTokens,
  normalizeTicker,
  publicDegenToken,
} from './degen-catalog.js';
import type { DegenConfig } from './types.js';

/**
 * D-067's degen list on the backend: the pinned curated core, avnu's live
 * list filtered by tag, routed volume and ticker, a TTL cache, and a fail-safe
 * to the curated core alone whenever avnu cannot be reached.
 */

const CONFIG: DegenConfig = {
  enabled: true,
  tags: ['Verified', 'Community', 'Unruggable', 'AVNU'],
  minDailyVolumeUsd: 100,
  cacheTtlMs: 600_000,
};

const LORDS = DEGEN_CURATED_CORE[0]!;
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

/** One avnu token entry, in the API's own shape (logo and extensions included). */
function avnu(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Ekubo Protocol',
    address: '0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87',
    symbol: 'EKUBO',
    decimals: 18,
    logoUri: 'https://example.invalid/ekubo.png',
    lastDailyVolumeUsd: 1742.44,
    extensions: { coingeckoId: 'ekubo' },
    tags: ['AVNU', 'Verified'],
    ...overrides,
  };
}

function address(n: number): string {
  return `0x${(0x5000n + BigInt(n)).toString(16)}`;
}

describe('the pinned curated core (D-067)', () => {
  it('is LORDS, DREAMS, SLAY, BROTHER, tBTC, CASH and DOG at their reviewed addresses and decimals', () => {
    expect(DEGEN_CURATED_CORE.map(({ symbol, address: token, decimals }) => [symbol, token, decimals])).toEqual([
      ['LORDS', '0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49', 18],
      ['DREAMS', '0x04fcaf2a7b4a072fe57c59beee807322d34ed65000d78611c909a46fead07fb1', 6],
      ['SLAY', '0x02ab526354a39e7f5d272f327fa94e757df3688188d4a92c6dc3623ab79894e2', 18],
      ['BROTHER', '0x03b405a98c9e795d427fe82cdeeeed803f221b52471e3a757574a2b4180793ee', 18],
      ['tBTC', '0x04daa17763b286d1e59b97c283c0b8c949994c361e426a28f743c67bdfe9a32f', 18],
      ['CASH', '0x0498edfaf50ca5855666a700c25dd629d577eb9afccdf3b5977aec79aee55ada', 18],
      ['DOG', '0x040e81cfeb176bfdbc5047bbc55eb471cfab20a6b221f38d8fda134e1bfffca4', 5],
    ]);
    expect(DEGEN_CURATED_CORE.every((token) => token.curated)).toBe(true);
    expect(new Set(DEGEN_CURATED_CORE.map((token) => BigInt(token.address))).size).toBe(7);
    expect(new Set(DEGEN_CURATED_CORE.map((token) => normalizeTicker(token.symbol))).size).toBe(7);
  });

  it('cannot be rewritten at runtime', () => {
    expect(Object.isFrozen(DEGEN_CURATED_CORE)).toBe(true);
    expect(Object.isFrozen(LORDS)).toBe(true);
    expect(Object.isFrozen(LORDS.tags)).toBe(true);
    expect(Reflect.set(LORDS, 'address', '0x1')).toBe(false);
    expect(Reflect.set(DEGEN_CURATED_CORE, 0, LORDS)).toBe(false);
  });

  it('is the whole list while avnu is unreachable', () => {
    expect(CURATED_ONLY_SNAPSHOT).toEqual({ source: 'curated', tokens: DEGEN_CURATED_CORE });
  });
});

describe('filtering avnu\'s live list', () => {
  it('keeps a token with an admitted tag at or above the volume floor, in avnu\'s tag order', () => {
    const { live } = filterLiveTokens([avnu({ tags: ['AVNU', 'Verified'] })], CONFIG);
    expect(live).toEqual([{
      address: '0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87',
      symbol: 'EKUBO',
      name: 'Ekubo Protocol',
      decimals: 18,
      tags: ['Verified', 'AVNU'],
      curated: false,
    }]);
  });

  it('drops a token below the floor and treats the floor itself as passing', () => {
    const tokens = [
      avnu({ address: address(1), symbol: 'AAA', lastDailyVolumeUsd: 99.99 }),
      avnu({ address: address(2), symbol: 'BBB', lastDailyVolumeUsd: 100 }),
      avnu({ address: address(3), symbol: 'CCC', lastDailyVolumeUsd: 0 }),
    ];
    expect(filterLiveTokens(tokens, CONFIG).live.map((token) => token.symbol)).toEqual(['BBB']);
  });

  it('never lists an Unknown-only token, and honours a narrower configured tag set', () => {
    const tokens = [
      avnu({ address: address(1), symbol: 'UNK', tags: ['Unknown'] }),
      avnu({ address: address(2), symbol: 'COM', tags: ['Community'] }),
      avnu({ address: address(3), symbol: 'RUG', tags: ['Unknown', 'Unruggable'] }),
      avnu({ address: address(4), symbol: 'VER', tags: ['Verified'] }),
    ];
    expect(filterLiveTokens(tokens, CONFIG).live.map((token) => token.symbol)).toEqual(['COM', 'RUG', 'VER']);
    expect(filterLiveTokens(tokens, { ...CONFIG, tags: ['Verified'] }).live.map((token) => token.symbol)).toEqual(['VER']);
    // The Unknown tag is shown as avnu gives it; it never qualifies a token on its own.
    expect(filterLiveTokens(tokens, CONFIG).live[1]!.tags).toEqual(['Unknown', 'Unruggable']);
  });

  it('refuses a ticker that impersonates a curated token, however it is spelled', () => {
    const impostors = ['LORDS', 'lords', 'Lords', ' LORDS'.trim(), 'L.O.R.D.S', 'LORDS$', 'dreams', 'DREAMS', 'tbtc', 'D-O-G']
      .map((symbol, index) => avnu({ address: address(index + 1), symbol, name: 'Totally real' }));
    expect(filterLiveTokens(impostors, CONFIG).live).toEqual([]);
  });

  it('refuses a ticker that impersonates a ground-floor asset, but lists the real one', () => {
    const tokens = [
      avnu({ address: address(1), symbol: 'USDC', name: 'USDC' }),
      avnu({ address: address(2), symbol: 'strk', name: 'Starknet' }),
      avnu({ address: STRK, symbol: 'STRK', name: 'Starknet', lastDailyVolumeUsd: 2_700_220 }),
    ];
    const { live } = filterLiveTokens(tokens, CONFIG);
    expect(live.map((token) => [token.symbol, token.address])).toEqual([['STRK', STRK]]);
  });

  it('lists neither of two live tokens that share a ticker', () => {
    const tokens = [
      avnu({ address: address(1), symbol: 'PEPE', lastDailyVolumeUsd: 900 }),
      avnu({ address: address(2), symbol: 'pepe', lastDailyVolumeUsd: 800 }),
      avnu({ address: address(3), symbol: 'EKUBO' }),
    ];
    expect(filterLiveTokens(tokens, CONFIG).live.map((token) => token.symbol)).toEqual(['EKUBO']);
  });

  it('keeps the first entry for a repeated address rather than calling it ambiguous', () => {
    const tokens = [avnu(), avnu({ lastDailyVolumeUsd: 5, name: 'Second copy' })];
    const { live } = filterLiveTokens(tokens, CONFIG);
    expect(live).toHaveLength(1);
    expect(live[0]!.name).toBe('Ekubo Protocol');
  });

  it('never adds a curated token twice, and takes avnu\'s current tags for it', () => {
    const { live, curatedTags } = filterLiveTokens([
      avnu({ address: LORDS.address, symbol: 'LORDS', name: 'Lords', tags: ['Community', 'Verified'], lastDailyVolumeUsd: 1 }),
    ], CONFIG);
    expect(live).toEqual([]);
    expect(curatedTags.get(BigInt(LORDS.address))).toEqual(['Verified', 'Community']);
    const snapshot = degenSnapshot('live', { live, curatedTags });
    expect(snapshot.tokens[0]).toMatchObject({ symbol: 'LORDS', decimals: 18, tags: ['Verified', 'Community'], curated: true });
    // Pinned metadata wins: avnu's entry cannot rename or re-decimal a curated token.
    const renamed = filterLiveTokens([avnu({ address: LORDS.address, symbol: 'LORDZ', decimals: 6, tags: ['Unknown'] })], CONFIG);
    expect(renamed.curatedTags.size).toBe(0);
    expect(degenSnapshot('live', renamed).tokens[0]).toEqual(LORDS);
  });

  it.each([
    ['a non-felt address', { address: 'not-an-address' }],
    ['a zero address', { address: '0x0' }],
    ['an out-of-field address', { address: `0x${'f'.repeat(64)}` }],
    ['a look-alike symbol from another script', { symbol: 'LОRDS' }],
    ['a control character in the symbol', { symbol: 'EK\u0000UBO' }],
    ['a symbol with edge spaces', { symbol: ' EKUBO ' }],
    ['an empty symbol', { symbol: '' }],
    ['an over-long symbol', { symbol: 'EKUBOEKUBOEKUBOEK' }],
    ['a symbol with no letter or digit', { symbol: '$$$' }],
    ['a non-ASCII name', { name: 'Ekubo ‮Protocol' }],
    ['an over-long name', { name: 'E'.repeat(65) }],
    ['negative decimals', { decimals: -1 }],
    ['fractional decimals', { decimals: 1.5 }],
    ['absurd decimals', { decimals: 77 }],
    ['a negative volume', { lastDailyVolumeUsd: -1 }],
    ['a non-finite volume', { lastDailyVolumeUsd: Number.POSITIVE_INFINITY }],
    ['a volume that is not a number', { lastDailyVolumeUsd: '5000' }],
    ['a tag avnu does not define', { tags: ['Verified', 'Meme'] }],
    ['a repeated tag', { tags: ['Verified', 'Verified'] }],
    ['no tags', { tags: [] }],
    ['tags that are not an array', { tags: 'Verified' }],
  ])('drops a token with %s', (_label, overrides) => {
    expect(filterLiveTokens([avnu(overrides)], CONFIG).live).toEqual([]);
  });

  it('reads own data fields only, and never runs an accessor', () => {
    const read = vi.fn(() => 'EKUBO');
    const hostile = avnu();
    delete hostile.symbol;
    Object.defineProperty(hostile, 'symbol', { get: read, enumerable: true });
    const inherited = Object.create(avnu()) as object;
    expect(filterLiveTokens([hostile, inherited, null, 7, 'EKUBO', [avnu()]], CONFIG).live).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it(`lists at most ${DEGEN_MAX_LIVE_TOKENS} live tokens, the highest-volume ones`, () => {
    const tokens = Array.from({ length: DEGEN_MAX_LIVE_TOKENS + 10 }, (_, index) =>
      avnu({ address: address(index + 1), symbol: `T${index}`, lastDailyVolumeUsd: 10_000 - index }));
    const { live } = filterLiveTokens(tokens, CONFIG);
    expect(live).toHaveLength(DEGEN_MAX_LIVE_TOKENS);
    expect(live[0]!.symbol).toBe('T0');
    expect(live.at(-1)!.symbol).toBe(`T${DEGEN_MAX_LIVE_TOKENS - 1}`);
  });

  it('puts the curated core first, then the live list, and publishes explicit fields only', () => {
    const snapshot = degenSnapshot('live', filterLiveTokens([avnu()], CONFIG));
    expect(snapshot.tokens.map((token) => token.symbol)).toEqual([
      'LORDS', 'DREAMS', 'SLAY', 'BROTHER', 'tBTC', 'CASH', 'DOG', 'EKUBO',
    ]);
    const published = publicDegenToken(snapshot.tokens.at(-1)!);
    expect(Object.keys(published).sort()).toEqual(['address', 'curated', 'decimals', 'name', 'symbol', 'tags']);
    expect(JSON.stringify(snapshot)).not.toContain('logo');
    expect(JSON.stringify(snapshot)).not.toContain('coingecko');
  });
});

describe('the backend-side avnu fetch and its cache', () => {
  function page(content: unknown[], totalPages = 1) {
    return { content, totalPages, totalElements: content.length, size: AVNU_TOKEN_PAGE_SIZE, number: 0 };
  }

  function catalog(
    fetchTokens: ReturnType<typeof vi.fn>,
    overrides: Partial<AvnuDegenCatalogOptions> & { clock?: { now: number } } = {},
  ) {
    const clock = overrides.clock ?? { now: 1_000 };
    const instance = new AvnuDegenCatalog({
      config: CONFIG,
      functions: { fetchTokens: fetchTokens as never },
      now: () => clock.now,
      ...overrides,
    });
    return { instance, clock };
  }

  it('asks avnu for fixed tags and pages only, from the backend, and returns the filtered list', async () => {
    const fetchTokens = vi.fn(async () => page([avnu()]));
    const { instance } = catalog(fetchTokens, { baseUrl: 'https://avnu.example' });

    const snapshot = await instance.snapshot();

    expect(snapshot.source).toBe('live');
    expect(snapshot.tokens.at(-1)!.symbol).toBe('EKUBO');
    expect(fetchTokens).toHaveBeenCalledOnce();
    const [request, options] = fetchTokens.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(request).toEqual({ page: 0, size: 200, tags: ['Verified', 'Community', 'Unruggable', 'AVNU'] });
    expect(Object.keys(options).sort()).toEqual(['abortSignal', 'baseUrl']);
    expect(options.baseUrl).toBe('https://avnu.example');
  });

  it('serves one fetched list for the whole TTL, then fetches again', async () => {
    const fetchTokens = vi.fn(async () => page([avnu()]));
    const { instance, clock } = catalog(fetchTokens);

    const first = await instance.snapshot();
    clock.now += CONFIG.cacheTtlMs - 1;
    expect(await instance.snapshot()).toBe(first);
    expect(fetchTokens).toHaveBeenCalledOnce();

    clock.now += 1;
    await instance.snapshot();
    expect(fetchTokens).toHaveBeenCalledTimes(2);
  });

  it('shares one refresh between concurrent requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchTokens = vi.fn(async () => { await gate; return page([avnu()]); });
    const { instance } = catalog(fetchTokens);

    const both = Promise.all([instance.snapshot(), instance.snapshot()]);
    release();
    const [a, b] = await both;
    expect(a).toBe(b);
    expect(fetchTokens).toHaveBeenCalledOnce();
  });

  it('fails safe to the curated core alone when avnu is down, and retries after a short window', async () => {
    const fetchTokens = vi.fn<() => Promise<unknown>>(async () => { throw new Error('503 Service Unavailable'); });
    const { instance, clock } = catalog(fetchTokens);

    expect(await instance.snapshot()).toBe(CURATED_ONLY_SNAPSHOT);
    clock.now += DEGEN_FAILURE_RETRY_MS - 1;
    expect(await instance.snapshot()).toBe(CURATED_ONLY_SNAPSHOT);
    expect(fetchTokens).toHaveBeenCalledOnce();

    fetchTokens.mockImplementation(async () => page([avnu()]));
    clock.now += 1;
    const recovered = await instance.snapshot();
    expect(recovered.source).toBe('live');
    expect(fetchTokens).toHaveBeenCalledTimes(2);
  });

  it('fails safe when avnu hangs past the fetch timeout, and aborts the fetch', async () => {
    let seen: AbortSignal | undefined;
    const fetchTokens = vi.fn((_request: unknown, options: { abortSignal: AbortSignal }) => {
      seen = options.abortSignal;
      return new Promise<never>((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), { once: true });
      });
    });
    const { instance } = catalog(fetchTokens, { fetchTimeoutMs: 10 });

    expect(await instance.snapshot()).toBe(CURATED_ONLY_SNAPSHOT);
    expect(seen?.aborted).toBe(true);
  });

  it.each([
    ['no content', { totalPages: 1 }],
    ['content that is not an array', { content: 'tokens' }],
    ['an oversized page', { content: Array.from({ length: AVNU_TOKEN_PAGE_SIZE + 1 }, () => avnu()) }],
    ['a non-object page', 'tokens'],
  ])('fails safe on a malformed page with %s', async (_label, result) => {
    const { instance } = catalog(vi.fn(async () => result));
    expect(await instance.snapshot()).toBe(CURATED_ONLY_SNAPSHOT);
  });

  it('reads another page only while a full page still ends at or above the floor', async () => {
    const full = (volume: number) => Array.from({ length: AVNU_TOKEN_PAGE_SIZE }, (_, index) =>
      avnu({ address: address(index + 1), symbol: `T${index}`, lastDailyVolumeUsd: volume }));
    const fetchTokens = vi.fn(async (request: { page: number }) =>
      page(request.page === 0 ? full(500) : full(50), 7));
    const { instance } = catalog(fetchTokens);
    await instance.snapshot();
    // Page 0 ended at 500 (>= 100), so page 1 was read; it ended at 50, so paging stopped.
    expect(fetchTokens.mock.calls.map((call) => (call[0] as { page: number }).page)).toEqual([0, 1]);
  });

  it(`never reads more than ${AVNU_TOKEN_MAX_PAGES} pages, or past avnu's last page`, async () => {
    const full = Array.from({ length: AVNU_TOKEN_PAGE_SIZE }, (_, index) =>
      avnu({ address: address(index + 1), symbol: `T${index}`, lastDailyVolumeUsd: 10_000 }));
    const endless = vi.fn(async () => page(full, 1_000));
    await catalog(endless).instance.snapshot();
    expect(endless).toHaveBeenCalledTimes(AVNU_TOKEN_MAX_PAGES);

    const twoPages = vi.fn(async () => page(full, 2));
    await catalog(twoPages).instance.snapshot();
    expect(twoPages).toHaveBeenCalledTimes(2);
  });

  it('lets a cancelled request stop waiting without cancelling the shared refresh', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchTokens = vi.fn(async () => { await gate; return page([avnu()]); });
    const { instance } = catalog(fetchTokens);
    const controller = new AbortController();

    const cancelled = instance.snapshot(controller.signal);
    const other = instance.snapshot();
    controller.abort(new DOMException('gone', 'AbortError'));
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect((await other).source).toBe('live');
    expect(fetchTokens).toHaveBeenCalledOnce();
  });

  it('refuses a malformed configuration at construction', () => {
    const fetchTokens = vi.fn();
    for (const config of [
      { ...CONFIG, tags: [] },
      { ...CONFIG, tags: ['Unknown'] },
      { ...CONFIG, tags: ['Verified', 'Verified'] },
      { ...CONFIG, minDailyVolumeUsd: 0 },
      { ...CONFIG, minDailyVolumeUsd: 1.5 },
      { ...CONFIG, cacheTtlMs: 59_999 },
      { ...CONFIG, cacheTtlMs: 86_400_001 },
    ]) {
      expect(() => new AvnuDegenCatalog({ config: config as DegenConfig, functions: { fetchTokens: fetchTokens as never } }))
        .toThrow('degen catalog configuration is invalid');
    }
    expect(fetchTokens).not.toHaveBeenCalled();
  });
});
