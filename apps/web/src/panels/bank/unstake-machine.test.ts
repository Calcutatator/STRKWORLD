import { describe, expect, it } from 'vitest';
import { DEMO_ENDUR_STAND_IN, ENDUR_XSTRK, FakePrivacyOperations } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { createUnstakePanel, formatTimeLeft, hasClaimable } from './unstake-machine.js';

/**
 * The Bank's unstaking counter (D-085) against the demo fake: request, the
 * wait read by the chain's clock, the claim, and every refusal on the way.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ONE = 10n ** 18n;
const SEVEN_DAYS = 604_800;
const UNSTAKE_DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'bank.unstake')!.disclosure;

function harness(options: { xstrk?: bigint; gate?: () => boolean; register?: readonly RouteGrade[]; shadow?: boolean } = {}) {
  const operations = new FakePrivacyOperations({
    balances: { [STRK]: 30n * ONE, ...(options.xstrk === 0n ? {} : { [ENDUR_XSTRK]: options.xstrk ?? 8n * ONE }) },
    poolConfig: { noteMaturityBlocks: 0 },
    ...(options.shadow === false ? { capability: { supportsShadowAccounts: false } } : {}),
  });
  const receipts = createReceiptLedger();
  const errors: string[] = [];
  const panel = createUnstakePanel({
    operations,
    receipts,
    canStartFinancialAction: options.gate ?? (() => true),
    onError: ({ kind }) => errors.push(kind),
    ...(options.register ? { register: options.register } : {}),
  });
  return { operations, receipts, panel, errors, state: () => panel.store.getState() };
}

describe('the unstaking counter (D-085)', () => {
  it('opens on a version query alone, and reads requests only when asked', async () => {
    const h = harness();
    await h.panel.open();
    expect(h.state()).toMatchObject({ door: { open: true }, claimDoor: { open: true }, capability: { status: 'supported' }, position: { status: 'unrequested' }, flow: { name: 'composing' } });
    await h.panel.refreshPosition();
    expect(h.state().position).toMatchObject({ status: 'loaded', standIn: DEMO_ENDUR_STAND_IN, requests: [], strkHeld: 0n });
    expect(hasClaimable(h.state().position)).toBe(false);
  });

  it('requests, shows the wait by the chain clock, then claims once ready', async () => {
    const h = harness();
    await h.panel.open();
    h.panel.setAmount('4');
    await h.panel.prepareRequest();
    const review = h.state().flow;
    expect(review).toMatchObject({
      name: 'review',
      summary: { action: { kind: 'request', shares: 4n * ONE, leftover: 0n }, routeId: 'bank.unstake', disclosures: [UNSTAKE_DISCLOSURE], requiresDisclosure: true },
    });
    await h.panel.confirm();
    expect(h.state().flow).toMatchObject({ name: 'submitted', outcome: 'succeeded', kind: 'request' });
    expect(h.state().notice).toEqual({ tone: 'info', text: COPY.unstake.changed });
    expect(h.receipts.pending('bank')).toHaveLength(1);
    h.panel.acknowledge();
    expect(h.receipts.pending('bank')).toHaveLength(0);

    await h.panel.refreshPosition();
    const waiting = h.state().position;
    expect(waiting.status === 'loaded' && waiting.requests.map(({ status, secondsLeft, assets }) => ({ status, secondsLeft, assets })))
      .toEqual([{ status: 'waiting', secondsLeft: SEVEN_DAYS, assets: 5n * ONE }]);
    expect(hasClaimable(waiting)).toBe(false);

    h.operations.advanceEndurClock(SEVEN_DAYS);
    await h.panel.refreshPosition();
    expect(hasClaimable(h.state().position)).toBe(true);
    await h.panel.prepareClaim();
    expect(h.state().flow).toMatchObject({
      name: 'review',
      summary: { action: { kind: 'claim', owed: 5n * ONE, held: 0n }, routeId: 'bank.unstake-claim', disclosures: [UNSTAKE_DISCLOSURE] },
    });
    await h.panel.confirm();
    expect(h.state().flow).toMatchObject({ name: 'submitted', kind: 'claim' });
    expect(h.operations.endurSubmitted.map(({ kind }) => kind)).toEqual(['request', 'claim']);
  });

  it('shows a request past its wait but unfunded as waiting for Endur, and offers no claim for it', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 30n * ONE },
      poolConfig: { noteMaturityBlocks: 0 },
      endur: { requests: [{ assets: 5n * ONE, shares: 4n * ONE, claimableInSeconds: -60, funded: false }] },
    });
    const panel = createUnstakePanel({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
    await panel.open();
    await panel.refreshPosition();
    const position = panel.store.getState().position;
    expect(position.status === 'loaded' && position.requests.map(({ status }) => status)).toEqual(['awaiting-funds']);
    expect(hasClaimable(position)).toBe(false);
    operations.fundEndurRequests();
    await panel.refreshPosition();
    expect(hasClaimable(panel.store.getState().position)).toBe(true);
  });

  it('says there is no xSTRK to unstake, and asks the wallet nothing more', async () => {
    const h = harness({ xstrk: 0n });
    await h.panel.open();
    h.panel.setAmount('1');
    await h.panel.prepareRequest();
    expect(h.state()).toMatchObject({ noXstrk: true, flow: { name: 'composing' } });
    expect(h.operations.endurSubmitted).toEqual([]);
    h.panel.setAmount('2');
    expect(h.state().noXstrk).toBe(false);
  });

  it('refuses a bad amount, and nothing starts while the session gate is shut', async () => {
    const h = harness();
    await h.panel.open();
    h.panel.setAmount('nope');
    await h.panel.prepareRequest();
    expect(h.state()).toMatchObject({ notice: { tone: 'error', text: COPY.notices.badAmount }, flow: { name: 'composing' } });
    const shut = harness({ gate: () => false });
    await shut.panel.open();
    shut.panel.setAmount('1');
    await shut.panel.prepareRequest();
    expect(shut.state()).toMatchObject({ notice: { text: COPY.errors['submission-uncertain'] }, flow: { name: 'composing' } });
  });

  it('tells a wallet without shadow accounts so, and keeps the form shut', async () => {
    const h = harness({ shadow: false });
    await h.panel.open();
    expect(h.state().capability).toEqual({ status: 'unsupported' });
    h.panel.setAmount('1');
    await h.panel.prepareRequest();
    expect(h.state().flow).toEqual({ name: 'composing' });
  });

  it('a prepared batch cannot be confirmed twice, and a cancel retires it', async () => {
    const h = harness();
    await h.panel.open();
    h.panel.setAmount('1');
    await h.panel.prepareRequest();
    const first = h.panel.confirm();
    const second = h.panel.confirm();
    await Promise.all([first, second]);
    expect(h.operations.endurSubmitted).toHaveLength(1);
    h.panel.acknowledge();
    h.panel.setAmount('1');
    await h.panel.prepareRequest();
    h.panel.cancelPrepared();
    await h.panel.confirm();
    expect(h.operations.endurSubmitted).toHaveLength(1);
  });

  it('keeps both doors shut when the register drops the routes', async () => {
    const register = PRIVACY_REGISTER.filter((entry) => !entry.route.startsWith('bank.unstake'));
    const h = harness({ register });
    await h.panel.open();
    expect(h.state().door.open).toBe(false);
    expect(h.state().claimDoor.open).toBe(false);
    h.panel.setAmount('1');
    await h.panel.prepareRequest();
    expect(h.operations.endurSubmitted).toEqual([]);
  });

  it.each([
    [0, 'under a minute'],
    [59, 'under a minute'],
    [60, '1 minute'],
    [3_660, '1 hour 1 minute'],
    [7_200, '2 hours'],
    [SEVEN_DAYS, '7 days'],
    [SEVEN_DAYS - 3_600, '6 days 23 hours'],
  ])('says %i seconds as "%s"', (seconds, text) => {
    expect(formatTimeLeft(seconds)).toBe(text);
  });
});
