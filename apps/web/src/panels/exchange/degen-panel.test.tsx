import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { COPY } from '../../copy.js';
import { createDemoOperations } from '../../privacy/demo-operations.js';
import { DEMO_DEGEN_CATALOG } from '../../privacy/demo-degen.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { degenExchangeCatalog, type DegenCatalogSnapshot, type DegenCatalogSource } from './degen-catalog.js';
import { ExchangePanel } from './ExchangePanel.js';
import { buyChoices, createExchangePanel } from './exchange-machine.js';

/**
 * The degen floor's counter (D-067) in demo: the Exchange's own machine and
 * review over the degen list, quoted by the demo seam's explicit DEMO rates.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const LORDS = '0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49';
const DOG = '0x040e81cfeb176bfdbc5047bbc55eb471cfab20a6b221f38d8fda134e1bfffca4';
const SSTR = '0x0102d5e124c51b936ee87302e0f938165aec96fb6c2027ae7f3a5ed46c77573b';
const SWAP_DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'exchange.swap')!.disclosure!;

function degenPanel(source: DegenCatalogSource | null = DEMO_DEGEN_CATALOG, admits: (token: string) => boolean = () => true) {
  const operations = createDemoOperations({ funded: true });
  const receipts = createReceiptLedger();
  const panel = createExchangePanel({
    operations,
    receipts,
    canStartFinancialAction: () => true,
    catalog: degenExchangeCatalog(source, admits),
  });
  return { operations, receipts, panel };
}

function render(panel: ReturnType<typeof degenPanel>['panel'], operations = createDemoOperations({ funded: true })): string {
  return renderToStaticMarkup(
    <PrivacyProvider operations={operations}>
      <ExchangePanel panel={panel} mode="degen" experience="station" onClose={() => {}} />
    </PrivacyProvider>,
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the degen counter in demo', () => {
  it('lists STRK and the degen list, then offers only positive swappable balances to sell', async () => {
    const { panel } = degenPanel();
    await panel.open();
    await settle();
    const opened = panel.store.getState();
    expect(opened.catalog.status).toBe('ready');
    if (opened.catalog.status !== 'ready') return;
    expect(opened.catalog.origin).toBe('demo');
    expect(opened.catalog.assets.map((asset) => asset.symbol)).toEqual([
      'STRK', 'LORDS', 'DREAMS', 'SLAY', 'BROTHER', 'tBTC', 'CASH', 'DOG', 'EKUBO', 'SSTR',
    ]);

    await panel.refreshBalances();
    const state = panel.store.getState();
    expect(state.sellChoices.map((asset) => asset.symbol)).toEqual(['STRK']);
    expect(state.buy?.symbol).toBe('LORDS');
    expect(buyChoices(state).map((asset) => asset.symbol)).toEqual([
      'LORDS', 'DREAMS', 'SLAY', 'BROTHER', 'tBTC', 'CASH', 'DOG', 'EKUBO',
    ]);
  });

  it('reviews AVNU\'s protected minimum and the fixed quote expiry, then confirms once', async () => {
    const { operations, receipts, panel } = degenPanel();
    await panel.open();
    await settle();
    await panel.refreshBalances();
    panel.setAmount('10');
    await panel.prepare();

    const reviewed = panel.store.getState().flow;
    expect(reviewed.name).toBe('review');
    if (reviewed.name !== 'review') return;
    // DEMO rate: 1 STRK counts as 10 LORDS; 0.5% slippage floors the minimum.
    expect(reviewed.summary).toEqual({
      sell: '10 STRK',
      expectedBuy: '100 LORDS',
      protectedMinimum: '99.5 LORDS',
      slippage: '0.50%',
      expiresAt: '2100-01-01T00:00:00.000Z',
      poolFee: '6 STRK',
      networkCost: '0 STRK',
      total: '6 STRK',
      disclosures: [SWAP_DISCLOSURE],
      rate: '1 STRK ≈ 10 LORDS',
      inverseRate: '1 LORDS ≈ 0.1 STRK',
      // The demo has no oracle (D-084); its fixture check carries no USD.
      sellUsd: null,
      expectedBuyUsd: null,
      priceCheck: 'checked',
      priceCheckNote: COPY.exchange.priceCheckedAbove,
    });

    await panel.confirm();
    const done = panel.store.getState().flow;
    expect(done.name).toBe('submitted');
    expect(operations.submitted).toEqual([[{
      kind: 'swap', tokenIn: STRK, tokenOut: LORDS, amountIn: 10n * 10n ** 18n, minAmountOut: 99_500000000000000000n, slippageBps: 50,
    }]]);
    expect(receipts.pending('exchange')).toHaveLength(1);
  });

  it('quotes a five-decimal token exactly', async () => {
    const { panel } = degenPanel();
    await panel.open();
    await settle();
    await panel.refreshBalances();
    panel.setBuy(DOG);
    panel.setAmount('1');
    await panel.prepare();
    const flow = panel.store.getState().flow;
    expect(flow.name).toBe('review');
    if (flow.name !== 'review') return;
    expect(flow.summary.expectedBuy).toBe('1000 DOG');
    expect(flow.summary.protectedMinimum).toBe('995 DOG');
  });

  it('keeps a display-only token out of the swap: not offered, not selectable, never prepared', async () => {
    const { operations, panel } = degenPanel();
    const prepare = vi.spyOn(operations, 'prepare');
    await panel.open();
    await settle();
    await panel.refreshBalances();
    expect(buyChoices(panel.store.getState()).some((asset) => BigInt(asset.token) === BigInt(SSTR))).toBe(false);
    panel.setBuy(SSTR);
    expect(panel.store.getState().buy?.symbol).toBe('LORDS');
    panel.setAmount('1');
    await panel.prepare();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]![0]).toEqual([expect.objectContaining({ tokenOut: LORDS })]);
  });

  it('marks and refuses tokens this build does not admit, and reads no balance for them', async () => {
    const onlyStrkAndLords = (token: string) => BigInt(token) === BigInt(STRK) || BigInt(token) === BigInt(LORDS);
    const { operations, panel } = degenPanel(DEMO_DEGEN_CATALOG, onlyStrkAndLords);
    const balances = vi.spyOn(operations, 'balances');
    await panel.open();
    await settle();
    await panel.refreshBalances();
    expect(balances.mock.calls[0]![0]).toEqual([STRK, LORDS]);
    expect(buyChoices(panel.store.getState()).map((asset) => asset.symbol)).toEqual(['LORDS']);
    panel.setBuy(DOG);
    expect(panel.store.getState().buy?.symbol).toBe('LORDS');
  });

  it('renders the degen look, the honest intro, the demo label and every token\'s avnu tags', async () => {
    const { operations, panel } = degenPanel();
    await panel.open();
    await settle();
    await panel.refreshBalances();
    const markup = render(panel, operations);

    expect(markup).toContain('data-building="exchange"');
    expect(markup).toContain('data-brand="degen"');
    expect(markup).toContain(`<p class="degen-eyebrow">${COPY.degen.eyebrow}</p>`);
    expect(markup).toContain(COPY.degen.intro);
    expect(markup).toContain(COPY.degen.demo.replaceAll("'", '&#x27;'));
    // D-090: no subtitle; the Route row says "via avnu" once.
    expect(markup).not.toContain('one swap at a time');
    // Chips name avnu's tags in words.
    expect(markup).toMatch(/<span class="degen-token-symbol">LORDS<\/span><span class="degen-token-name">Lords<\/span><span class="degen-chips"><span class="degen-chip" data-tag="verified">Verified<\/span><span class="degen-chip" data-tag="avnu">AVNU<\/span><\/span>/);
    expect(markup).toContain('<span class="degen-chip" data-tag="unruggable">Unruggable</span>');
    expect(markup).toContain('<span class="degen-chip" data-tag="community">Community</span>');
    // The display-only token is listed and marked, never offered.
    expect(markup).toMatch(/<li class="degen-token" data-display-only="true"><span class="degen-token-symbol">SSTR<\/span>.*?data-tag="display-only">Display only<\/span>/);
    expect(markup).toContain(COPY.degen.displayOnlyNote);
    expect(markup).not.toMatch(new RegExp(`<option value="${SSTR}"`));
    // D-090: the selector shows the ticker alone; the name is on the board.
    expect(markup).toMatch(new RegExp(`<option value="${LORDS}"( selected="")?>LORDS</option>`));
    // The list scrolls on its own and can take keyboard focus.
    expect(markup).toMatch(/class="degen-board-scroll" role="region" aria-labelledby="[^"]+" tabindex="0"/);
  });

  it('keeps the review exactly as the ground floor\'s: figures, glossary and disclosure inside ConfirmGate', async () => {
    const { operations, panel } = degenPanel();
    await panel.open();
    await settle();
    await panel.refreshBalances();
    panel.setAmount('10');
    await panel.prepare();
    const markup = render(panel, operations);
    const gate = markup.slice(markup.indexOf('class="confirm-gate"'));
    for (const value of ['10 STRK', '100 LORDS', '99.5 LORDS', '0.50%', '2100-01-01T00:00:00.000Z', '6 STRK', SWAP_DISCLOSURE]) {
      expect(gate).toContain(value);
    }
    for (const definition of [COPY.glossary.protectedMinimum, COPY.glossary.quoteExpiry]) expect(gate).toContain(definition);
    expect((gate.match(/<details class="glossary-term">/g) ?? [])).toHaveLength(5);
    // The degen label stays on screen at commit.
    expect(markup).toContain(COPY.degen.eyebrow);
  });

  it('says when only the core list could be read', async () => {
    const curatedOnly: DegenCatalogSource = {
      async load(): Promise<DegenCatalogSnapshot> {
        const demo = await DEMO_DEGEN_CATALOG.load();
        return { origin: 'curated', listings: demo.listings.filter((listing) => listing.curated) };
      },
    };
    const { operations, panel } = degenPanel(curatedOnly);
    await panel.open();
    await settle();
    const markup = render(panel, operations);
    expect(markup).toContain(COPY.degen.curatedOnly.replaceAll("'", '&#x27;'));
    expect(markup).not.toContain(COPY.degen.demo.replaceAll("'", '&#x27;'));
  });

  it('fails closed without a list, offers no balance read, and recovers on retry', async () => {
    let up = false;
    const flaky: DegenCatalogSource = {
      async load() {
        if (!up) throw new Error('down');
        return DEMO_DEGEN_CATALOG.load();
      },
    };
    const { operations, panel } = degenPanel(flaky);
    await panel.open();
    await settle();
    expect(panel.store.getState().catalog.status).toBe('failed');
    const failed = render(panel, operations);
    expect(failed).toContain(COPY.degen.unavailable);
    expect(failed).toContain(COPY.degen.retry);
    expect(failed).not.toContain(COPY.balance.refresh);
    expect(failed).not.toContain('name="amount"');

    await panel.refreshBalances();
    expect(panel.store.getState()).toMatchObject({ balances: 'unrequested', notice: COPY.degen.notReady });

    up = true;
    await panel.reloadCatalog();
    expect(panel.store.getState().catalog.status).toBe('ready');
    expect(render(panel, operations)).toContain(COPY.balance.refresh);
  });

  it('says the list is unavailable in a build that has none', async () => {
    const { operations, panel } = degenPanel(null);
    await panel.open();
    await settle();
    expect(render(panel, operations)).toContain(COPY.degen.unavailable);
  });

  it('rejects a malformed list as a whole', async () => {
    const hostile: DegenCatalogSource = {
      async load() {
        return { origin: 'live', listings: [{ token: 'not-a-token', symbol: 'X', name: 'X', decimals: 18, tags: [], curated: false }] };
      },
    };
    const { panel } = degenPanel(hostile);
    await panel.open();
    await settle();
    // The base asset is still fine, but the malformed listing fails the load.
    expect(panel.store.getState().catalog.status).toBe('failed');
  });

  it('ignores a list that lands after the counter closed', async () => {
    let release!: (snapshot: DegenCatalogSnapshot) => void;
    const slow: DegenCatalogSource = { load: () => new Promise((resolve) => { release = resolve; }) };
    const { panel } = degenPanel(slow);
    await panel.open();
    panel.close();
    release(await DEMO_DEGEN_CATALOG.load());
    await settle();
    expect(panel.store.getState().catalog.status).toBe('idle');
  });

  it('leaves the ground floor\'s fixed six untouched', async () => {
    const ground = createExchangePanel({ operations: createDemoOperations({ funded: true }), receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    const state = ground.store.getState();
    expect(state.catalog).toMatchObject({ status: 'ready', origin: 'fixed' });
    if (state.catalog.status !== 'ready') return;
    expect(state.catalog.assets.map((asset) => asset.symbol)).toEqual(['STRK', 'ETH', 'USDC', 'USDT', 'WBTC', 'strkBTC']);
    await ground.reloadCatalog();
    expect(ground.store.getState().catalog).toBe(state.catalog);
  });
});
