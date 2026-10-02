// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_VAULT_STAND_IN, FakePrivacyOperations, PrivacyError, type PrivacyOperations } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../../bus/event-bus.js';
import type { ConnectState } from '../../connect/connect-machine.js';
import { COPY } from '../../copy.js';
import { formatTokenAmount, shortenAddress } from '../../format.js';
import { createDemoOperations } from '../../privacy/demo-operations.js';
import { PrivacyProvider, usePrivacy } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import { VisitLayer } from '../../visits/VisitLayer.js';

/**
 * The Vault (D-077, D-079) as a player drives it through the real visit
 * layer, in demo: the World opens the door and the counter, and every step
 * after that is a click or a keystroke on the rendered window. The
 * assertions read what is on screen, and what reached the seam.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const STRKBTC = '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135';
const XSTRK = '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';
/** The markets Vesu lends out: the ones listed and offered before any read (D-081). */
const LENDABLE = ['STRK', 'ETH', 'USDC', 'USDT', 'USDC.e', 'WBTC', 'strkBTC', 'tBTC', 'SolvBTC', 'wstETH', 'LBTC'];
const DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'vault.supply')!.disclosure!;
const CONNECTED: ConnectState = {
  name: 'connected',
  capability: { supportsStrk20: true, walletApiVersion: '0.10.4', registration: 'registered', supportsShadowAccounts: true },
  registrationConfirmed: true,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function ConnectStateProbe() {
  return <output data-testid="connect-state">{usePrivacy().connectState.name}</output>;
}

async function openCounter(operations: PrivacyOperations, station: 'vault:supply' | 'vault:redeem' = 'vault:supply') {
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  const stations: Array<ShellEvents['world:stations']> = [];
  shell.on('world:stations', (payload) => stations.push(payload));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <PrivacyProvider operations={operations} initialConnectState={CONNECTED} shellBus={shell}>
        <ConnectStateProbe />
        <VisitLayer world={world} shell={shell} />
      </PrivacyProvider>,
    );
  });
  await act(async () => world.emit('building:entered', { building: 'vault' }));
  await act(async () => world.emit('station:activated', { building: 'vault', station }));
  await settle();
  return { stations, world };
}

/** Close this counter's window and walk up to another, as a player does (D-103). */
async function walkTo(world: ReturnType<typeof createEventBus<WorldEvents>>, station: 'vault:supply' | 'vault:redeem'): Promise<void> {
  await click(button(COPY.flow.close));
  await act(async () => world.emit('station:activated', { building: 'vault', station }));
  await settle();
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await settle();
}

async function choose(value: string): Promise<void> {
  const select = container!.querySelector<HTMLSelectElement>('select[name="token"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function type(value: string): Promise<void> {
  const input = container!.querySelector<HTMLInputElement>('input[name="amount"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function vault(): Element {
  const panel = container!.querySelector('section.panel[data-building="vault"]');
  if (!panel) throw new Error('The Vault window is not open.');
  return panel;
}

describe('the Vault counter, driven through the screen in demo (D-077, D-079, D-081)', () => {
  it('supplies STRK and redeems it all, with the approved disclosure at every commit point', async () => {
    const operations = createDemoOperations({ funded: true });
    const { stations, world } = await openCounter(operations);

    // The World was told the counters are open: presentation only (D-083, D-103).
    expect(stations.at(-1)).toEqual({
      building: 'vault',
      stations: [
        { station: 'vault:supply', label: 'SUPPLY', status: 'available' },
        { station: 'vault:redeem', label: 'REDEEM', status: 'available' },
        { station: 'vault:borrow', label: 'BORROW', status: 'available' },
        { station: 'vault:repay', label: 'REPAY', status: 'available' },
      ],
    });
    // SUPPLY does one thing: no Supply / Redeem tabs.
    expect(vault().querySelector('.panel-body .panel-modes')).toBeNull();
    expect(vault().querySelector('.vault-stand-in')).toBeNull();

    // Vesu's window, what it does, and how fees work; the disclosure previewed.
    const panel = vault();
    expect(panel.querySelector('.vault-eyebrow')?.textContent).toBe(COPY.vault.eyebrow);
    expect(panel.textContent).toContain(COPY.vault.intro);
    expect(panel.querySelector('.vault-note')?.textContent).toBe(COPY.vault.feeNote);
    expect(panel.querySelector('[data-testid="disclosure"]')?.textContent).toBe(DISCLOSURE);

    // The position is read only when asked.
    expect(panel.textContent).toContain(COPY.vault.position.unrequested);
    await click(button(COPY.vault.position.show));
    expect(vault().textContent).toContain(COPY.vault.position.empty);

    // Every market Vesu lends out has a row, in its group; the demo states no rate, so none shows.
    // Collateral-only markets are not listed while nothing is held in them (D-081).
    expect([...panel.querySelectorAll('.vault-market-symbol')].map((node) => node.textContent)).toEqual(LENDABLE);
    expect(panel.querySelector('.vault-apy')).toBeNull();
    // STRK is chosen first, so no note about the fee's token.
    expect(panel.querySelector('.vault-fee-token')).toBeNull();

    // Supply 5 STRK: the button says what is missing until an amount is in (D-089).
    expect(button(COPY.kit.enterAmount).disabled).toBe(true);
    await type('5');
    expect([...vault().querySelectorAll('.panel-compose .ui-detail')].map((row) => row.textContent)).toEqual([`${COPY.vault.form.willSupply}5 STRK`]);
    await click(button(COPY.gameMode.reviewAction));
    const review = vault().querySelector('.panel-review')!;
    expect([...review.querySelectorAll('.vault-review dd')].map((dd) => dd.textContent)).toEqual(['5 STRK']);
    expect(review.textContent).toContain(COPY.vault.review.networkByWallet);
    expect([...review.querySelectorAll('.commit-disclosures li')].map((li) => li.textContent)).toEqual([DISCLOSURE]);
    // At the commit point the gate carries the disclosure; the header preview is withdrawn.
    expect(vault().querySelector('[data-testid="disclosure"]')).toBeNull();
    const confirm = review.querySelector<HTMLButtonElement>('button.confirm')!;
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(operations.vaultSubmitted).toEqual([{ kind: 'supply', token: STRK, amount: 5n * 10n ** 18n }]);
    expect(vault().querySelector('.flow-done')?.textContent).toContain(COPY.vault.submitted.succeeded);
    expect(vault().textContent).toContain(COPY.vault.position.changed);

    // Back at the counter, the position now shows what it holds.
    await click(button(COPY.flow.back));
    await click(button(COPY.vault.position.show));
    expect(vault().textContent).toContain(COPY.vault.position.worth);

    // Redeem everything at REDEEM: the field shows what is supplied, and Max
    // fills the whole position, which redeems every share (D-089, D-103).
    await walkTo(world, 'vault:redeem');
    await click(button(COPY.vault.position.show));
    expect(vault().querySelector('.ui-amount-balance')?.textContent).toMatch(new RegExp(`^${COPY.vault.form.supplied}: [0-9.]+ STRK$`));
    await click(button(COPY.kit.max));
    expect(vault().querySelector<HTMLInputElement>('input[name="amount"]')!.value).not.toBe('');
    await click(button(COPY.gameMode.reviewAction));
    const redeem = vault().querySelector('.panel-review')!;
    expect(redeem.textContent).toContain(COPY.vault.review.redeemAll);
    expect(redeem.textContent).toContain(COPY.vault.review.allNote);
    expect([...redeem.querySelectorAll('.commit-disclosures li')].map((li) => li.textContent)).toEqual([
      PRIVACY_REGISTER.find((entry) => entry.route === 'vault.redeem')!.disclosure,
    ]);
    await click(redeem.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.vaultSubmitted.at(-1)).toMatchObject({ kind: 'redeem', all: true });
    await click(button(COPY.flow.back));
    await click(button(COPY.vault.position.show));
    expect(vault().textContent).toContain(COPY.vault.position.empty);
  });

  it('lends USDC in its own units, says where the fee comes from, and shows the public stand-in address (D-079)', async () => {
    // Node 25 exposes a method-less localStorage; the page's storage is jsdom's, on window.
    const storages = [window.sessionStorage, window.localStorage].filter((storage) => typeof storage?.clear === 'function');
    for (const storage of storages) storage.clear();
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n, [USDC]: 100n * 10n ** 6n },
      poolConfig: { noteMaturityBlocks: 0 },
      vault: { rates: { [USDC]: { value: 30925508207480051n, decimals: 18 }, [STRK]: { value: 27351899613523568n, decimals: 18 } } },
    });
    await openCounter(operations);

    // Vesu's rates, labelled as Vesu's, beside each token that has one.
    const rows = () => [...vault().querySelectorAll('.vault-market')];
    const row = (symbol: string) => rows().find((node) => node.getAttribute('data-token') === symbol)!;
    expect(row('STRK').querySelector('.vault-apy')?.textContent).toBe("Supply APY 2.73%, Vesu's figure");
    expect(row('USDC').querySelector('.vault-apy')?.textContent).toBe("Supply APY 3.09%, Vesu's figure");
    expect(row('ETH').querySelector('.vault-apy')).toBeNull();

    // Choose USDC: the amount is read in USDC, and the fee's token is explained.
    await choose(USDC);
    expect(vault().querySelector('.vault-fee-token')?.textContent).toBe(COPY.vault.feeInStrk);
    expect(vault().querySelector('.ui-amount-symbol')?.textContent).toBe('USDC');
    // The chosen market's APY sits in the form too (D-089).
    expect(vault().querySelector('.panel-compose .ui-detail')?.textContent).toBe(`${COPY.vault.rates.label}3.09%, Vesu's figure`);
    await type('12.5');
    await click(button(COPY.gameMode.reviewAction));
    const review = vault().querySelector('.panel-review')!;
    expect([...review.querySelectorAll('.vault-review dd')].map((dd) => dd.textContent)).toEqual(['12.5 USDC']);
    // The pool fee is the pool's, in STRK, and the wallet picks what pays it.
    expect([...review.querySelectorAll('.review-costs dd')].map((dd) => dd.textContent)[0]).toBe('6 STRK');
    expect(review.querySelector('.vault-fee-token')?.textContent).toBe(COPY.vault.review.feeTokenByWallet);
    expect([...review.querySelectorAll('.commit-disclosures li')].map((li) => li.textContent)).toEqual([DISCLOSURE]);
    await click(review.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.vaultSubmitted).toEqual([{ kind: 'supply', token: USDC, amount: 12_500_000n }]);

    // Each position in its token's units: shares converted by the vault's own (demo) preview.
    await click(button(COPY.flow.back));
    await click(button(COPY.vault.position.show));
    const shares = (12_500_000n * 50n) / 51n;
    const worth = (shares * 51n) / 50n;
    expect(row('USDC').querySelector('.vault-figures .balance-total')?.textContent).toBe(`${formatTokenAmount(worth, 6, 6)} USDC`);
    expect(row('STRK').querySelector('.vault-market-none')?.textContent).toBe(COPY.vault.position.none);
    expect(vault().querySelector('.vault-as-of')?.textContent).toBe(COPY.vault.position.asOf);
    expect(button(COPY.vault.position.again)).toBeDefined();

    // The stand-in address is public, and a link to it opens only on request, in a new tab, with no referrer.
    const line = vault().querySelector('.vault-stand-in')!;
    expect(line.textContent).toContain(
      `${COPY.vault.standIn.lead} ${shortenAddress(DEMO_VAULT_STAND_IN)}, ${COPY.vault.standIn.tail}`,
    );
    const link = line.querySelector('a')!;
    expect(link.textContent).toBe(COPY.vault.standIn.voyager);
    expect(link.getAttribute('href')).toBe(`https://voyager.online/contract/${DEMO_VAULT_STAND_IN}`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(line.textContent).toContain(COPY.vault.standIn.voyagerNote);

    // Never persisted.
    expect(storages.length).toBeGreaterThan(0);
    const stored = storages
      .flatMap((storage) => Array.from({ length: storage.length }, (_, index) => `${storage.key(index)}=${storage.getItem(storage.key(index)!)}`))
      .join(' ');
    expect(stored).not.toContain('de70');
  });

  it('shows every position in its own token’s decimals and symbol, never the vault’s shares (D-079)', async () => {
    const WBTC = '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac';
    const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n },
      vault: { markets: { [WBTC]: { shares: 12_102n }, [ETH]: { shares: 5n * 10n ** 17n, liquidity: 10n ** 17n } } },
    });
    await openCounter(operations);
    await click(button(COPY.vault.position.show));
    const figures = (symbol: string) => [
      ...vault().querySelectorAll(`.vault-market[data-token="${symbol}"] .vault-figures dd`),
    ].map((dd) => dd.textContent);
    // 12,102 demo shares redeem for 12,344 satoshis: eight decimals, WBTC's own.
    expect(figures('WBTC')).toEqual(['0.00012344 WBTC', '0.00012344 WBTC']);
    // Half an ETH of shares is worth 0.51 ETH; the demo vault pays out 0.1 now.
    expect(figures('ETH')).toEqual(['0.51 ETH', '0.1 ETH']);
    expect(vault().textContent).not.toContain(COPY.vault.position.empty);
  });

  it('groups the markets and the picker, names each pool, and lends strkBTC through its curated pool (D-081)', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n },
      poolConfig: { noteMaturityBlocks: 0 },
      vault: { rates: { [STRKBTC]: { value: 5981411732929n, decimals: 18 } } },
    });
    await openCounter(operations);

    // The market list, by group, each row naming its pool; one line says what curated means.
    // Ecosystem's one market, EKUBO, is collateral only, so the group is left out (D-081).
    const groups = [...vault().querySelectorAll('.vault-market-group')];
    expect(groups.map((group) => group.querySelector('.vault-group-title')?.textContent)).toEqual([
      COPY.vault.groups.majors, COPY.vault.groups.stables, COPY.vault.groups.btc, COPY.vault.groups.staking,
    ]);
    expect(groups.map((group) => group.getAttribute('data-group'))).toEqual(['majors', 'stables', 'btc', 'staking']);
    const row = (symbol: string) => vault().querySelector(`.vault-market[data-token="${symbol}"]`)!;
    expect(row('STRK').querySelector('.vault-market-pool')?.textContent).toBe('Prime');
    expect(row('STRK').getAttribute('aria-current')).toBe('true');
    expect(row('strkBTC').querySelector('.vault-market-pool')?.textContent).toBe(`Re7 xBTC, ${COPY.vault.pools.curated}`);
    expect(row('strkBTC').getAttribute('data-curation')).toBe('curated');
    // Vesu's 0.0006% reads as under a hundredth of a percent, never as zero.
    expect(row('strkBTC').querySelector('.vault-apy')?.textContent).toBe("Supply APY <0.01%, Vesu's figure");
    expect(row('strkBTC').getAttribute('data-lendable')).toBe('true');
    expect(vault().querySelector('.vault-market[data-token="EKUBO"]')).toBeNull();
    expect(vault().querySelector('.vault-curated-note')?.textContent).toBe(COPY.vault.pools.curatedNote);

    // The picker, grouped the same way; a curated market names its pool.
    const select = vault().querySelector<HTMLSelectElement>('select[name="token"]')!;
    expect([...select.querySelectorAll('optgroup')].map((group) => group.label)).toEqual([
      COPY.vault.groups.majors, COPY.vault.groups.stables, COPY.vault.groups.btc, COPY.vault.groups.staking,
    ]);
    expect([...select.querySelectorAll('optgroup')][2]!.textContent).toContain('strkBTC (Re7 xBTC)');
    // Only the eleven markets Vesu lends out: never a collateral-only one (D-081).
    expect([...select.options].map((option) => option.textContent?.replace(/ \(.*\)$/, ''))).toEqual(LENDABLE);
    expect(vault().querySelector('.vault-pool')?.textContent).toBe(`${COPY.vault.pools.label}: Prime`);
    expect(vault().querySelector('.vault-holding')?.textContent).toBe(`${COPY.vault.holding.neededLead} STRK ${COPY.vault.holding.neededTail}`);

    // strkBTC, with none of it in the pool balance: said plainly, and nothing asked of the wallet.
    await choose(STRKBTC);
    expect(vault().querySelector('.vault-pool')?.textContent).toBe(`${COPY.vault.pools.label}: Re7 xBTC, ${COPY.vault.pools.curated}`);
    expect(vault().querySelector('.vault-fee-token')?.textContent).toBe(COPY.vault.feeInStrk);
    await type('0.001');
    await click(button(COPY.gameMode.reviewAction));
    expect(vault().querySelector('.vault-holding-none')?.textContent).toBe(
      'You have no strkBTC in your pool balance, so there is nothing to supply. Shield some first, or choose another token.',
    );
    expect(vault().querySelector('.panel-review')).toBeNull();
    expect(operations.vaultSubmitted).toEqual([]);
    // Reading is never blocked by it.
    await click(button(COPY.vault.position.show));
    expect(vault().textContent).toContain(COPY.vault.position.empty);
  });

  it('supplies strkBTC through Re7 xBTC in its own units once the pool balance holds some (D-081)', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n, [STRKBTC]: 10n ** 8n },
      poolConfig: { noteMaturityBlocks: 0 },
    });
    await openCounter(operations);
    await choose(STRKBTC);
    await type('0.001');
    await click(button(COPY.gameMode.reviewAction));
    const review = vault().querySelector('.panel-review')!;
    expect([...review.querySelectorAll('.vault-review dd')].map((dd) => dd.textContent)).toEqual(['0.001 strkBTC']);
    expect([...review.querySelectorAll('.commit-disclosures li')].map((li) => li.textContent)).toEqual([DISCLOSURE]);
    await click(review.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.vaultSubmitted).toEqual([{ kind: 'supply', token: STRKBTC, amount: 100_000n }]);
  });

  it('lists a collateral-only position once read, says it earns nothing, and redeems it, never offering it for supply (D-081)', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n },
      poolConfig: { noteMaturityBlocks: 0 },
      vault: { markets: { [XSTRK]: { shares: 20n * 10n ** 18n } } },
    });
    const { world } = await openCounter(operations);
    const options = () => [...vault().querySelectorAll<HTMLOptionElement>('select[name="token"] option')].map((option) => option.value);
    expect(vault().querySelector('.vault-market[data-token="xSTRK"]')).toBeNull();
    expect(options()).not.toContain(XSTRK);

    await click(button(COPY.vault.position.show));
    const row = vault().querySelector('.vault-market[data-token="xSTRK"]')!;
    expect(row.getAttribute('data-lendable')).toBe('false');
    expect(row.querySelector('.vault-market-note')?.textContent).toBe(COPY.vault.collateralOnly);
    expect([...row.querySelectorAll('.vault-figures dd')].map((dd) => dd.textContent)).toEqual(['20.4 xSTRK', '20.4 xSTRK']);
    // Still never offered for supply.
    expect(options()).not.toContain(XSTRK);

    // REDEEM offers it, with the same note, and redeems it all.
    await walkTo(world, 'vault:redeem');
    await click(button(COPY.vault.position.show));
    expect(options()).toContain(XSTRK);
    await choose(XSTRK);
    expect(vault().querySelector('.panel-compose .vault-market-note')?.textContent).toBe(COPY.vault.collateralOnly);
    await click(button(COPY.kit.max));
    await click(button(COPY.gameMode.reviewAction));
    const review = vault().querySelector('.panel-review')!;
    expect([...review.querySelectorAll('.vault-review dd')].map((dd) => dd.textContent)).toEqual(['20.4 xSTRK']);
    await click(review.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.vaultSubmitted).toEqual([{ kind: 'redeem', token: XSTRK, amount: 20_400_000_000_000_000_000n, all: true }]);
  });

  it('shows the pool balance once asked, fills a Max that leaves the pool fee, and says what is short (D-089)', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n, [USDC]: 25n * 10n ** 6n },
      poolConfig: { noteMaturityBlocks: 0 },
    });
    await openCounter(operations);
    // Nothing read until the player asks: no balance line, no Max.
    expect(vault().querySelector('.ui-amount-balance')).toBeNull();
    expect([...vault().querySelectorAll('.panel-compose button')].some((node) => node.textContent === COPY.kit.max)).toBe(false);
    await click(button(COPY.vault.form.showBalance));
    expect(vault().querySelector('.ui-amount-balance')?.textContent).toBe(`${COPY.kit.poolBalance}: 100 STRK`);

    // Max on STRK, the fee token, leaves the 6 STRK pool fee behind, and says so.
    await click(button(COPY.kit.max));
    expect(vault().querySelector<HTMLInputElement>('input[name="amount"]')!.value).toBe('94');
    expect(vault().querySelector('.ui-amount-hint')?.textContent).toBe(COPY.balance.feeReserved);

    // More than the pool balance: the field and the button both say so.
    await type('200');
    expect(vault().querySelector('.ui-amount-message')?.textContent).toBe(COPY.kit.exceedsBalance);
    expect(button('Insufficient STRK').disabled).toBe(true);

    // USDC pays no pool fee of its own, so Max is all of it.
    await choose(USDC);
    expect(vault().querySelector('.ui-amount-balance')?.textContent).toBe(`${COPY.kit.poolBalance}: 25 USDC`);
    await click(button(COPY.kit.max));
    expect(vault().querySelector<HTMLInputElement>('input[name="amount"]')!.value).toBe('25');
    expect(vault().querySelector('.ui-amount-hint')).toBeNull();
    await click(button(COPY.gameMode.reviewAction));
    await click(vault().querySelector<HTMLButtonElement>('.panel-review button.confirm')!);
    expect(operations.vaultSubmitted).toEqual([{ kind: 'supply', token: USDC, amount: 25n * 10n ** 6n }]);
  });

  it('fills Max from a wallet\'s one total per token, and says funds are settling when the wallet refuses a note still maturing (D-089)', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 100n * 10n ** 18n }, poolConfig: { noteMaturityBlocks: 0 } });
    const read = operations.balances.bind(operations);
    // As the Wallet API adapter answers: `wallet_strk20Balances` gives one total per token.
    operations.balances = async (tokens, signal) => (await read(tokens, signal))
      .map((entry) => ({ ...entry, spendable: 0n, maturing: 0n, maturityKnown: false }));
    // The wallet refuses a spend that counts a note still maturing, as an insufficient balance (119).
    const prepare = operations.prepareVaultSupply.bind(operations);
    let refuse = true;
    operations.prepareVaultSupply = async (...args) => {
      if (refuse) {
        refuse = false;
        throw new PrivacyError('insufficient-balance', 'Insufficient shielded balance.');
      }
      return prepare(...args);
    };
    await openCounter(operations);
    await click(button(COPY.vault.form.showBalance));
    expect(vault().querySelector('.ui-amount-balance')?.textContent).toBe(`${COPY.kit.poolBalance}: 100 STRK`);
    await click(button(COPY.kit.max));
    expect(vault().querySelector<HTMLInputElement>('input[name="amount"]')!.value).toBe('94');
    await click(button(COPY.gameMode.reviewAction));
    expect(vault().querySelector('.flow-failed')?.textContent).toContain(COPY.vault.form.settling);

    // A few seconds later the same supply goes through.
    await click(button(COPY.flow.back));
    await click(button(COPY.gameMode.reviewAction));
    await click(vault().querySelector<HTMLButtonElement>('.panel-review button.confirm')!);
    expect(operations.vaultSubmitted).toEqual([{ kind: 'supply', token: STRK, amount: 94n * 10n ** 18n }]);
  });

  it('keeps the plain message for a refusal the read balance does not cover', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 100n * 10n ** 18n }, poolConfig: { noteMaturityBlocks: 0 } });
    operations.prepareVaultSupply = async () => {
      throw new PrivacyError('insufficient-balance', 'Insufficient shielded balance.');
    };
    await openCounter(operations);
    // No balance read: nothing says the funds are there, so it is the ordinary message.
    await type('5');
    await click(button(COPY.gameMode.reviewAction));
    expect(vault().querySelector('.flow-failed')?.textContent).toContain(COPY.errors['insufficient-balance']);
    expect(vault().textContent).not.toContain(COPY.vault.form.settling);
  });

  it('tells a wallet without shadow accounts so plainly, offers no form, and keeps the city open', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n },
      capability: { supportsShadowAccounts: false, walletApiVersion: '0.10.3' },
    });
    await openCounter(operations);
    const panel = vault();
    expect(panel.querySelector('.vault-unsupported')?.textContent).toBe(COPY.errors['shadow-accounts-unsupported']);
    expect(panel.querySelector('input[name="amount"]')).toBeNull();
    expect(panel.querySelector('button.confirm')).toBeNull();
    // A fact about the wallet's release: the connect flow never moves.
    expect(container!.querySelector('[data-testid="connect-state"]')?.textContent).toBe('connected');
    expect(operations.vaultSubmitted).toEqual([]);
  });
});
