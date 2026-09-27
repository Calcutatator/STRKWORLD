import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Address, Intent } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { EXCHANGE_CATALOG } from './exchange/catalog.js';
import { nextStepAfterIntents, offersBridgeArrival } from './next-step.js';

const STRK = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'STRK')!.token;
const ETH = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'ETH')!.token;
const FRIEND: Address = '0x0456';

const shield: Intent = { kind: 'shield', token: STRK, amount: 1n };
const unshield: Intent = { kind: 'unshield', token: STRK, amount: 1n, recipient: FRIEND };
const transfer: Intent = { kind: 'transfer', token: STRK, amount: 1n, recipient: FRIEND };
const swapInto = (tokenOut: Address): Intent => ({ kind: 'swap', tokenIn: ETH === tokenOut ? STRK : ETH, tokenOut, amountIn: 1n, minAmountOut: 1n });

function withRoute(route: string, change: Partial<RouteGrade> | null): readonly RouteGrade[] {
  return change === null
    ? PRIVACY_REGISTER.filter((entry) => entry.route !== route)
    : PRIVACY_REGISTER.map((entry) => (entry.route === route ? { ...entry, ...change } : entry));
}

const unapproved = { approvedBy: null, approvedOn: null } as const;

describe('next-step prompts', () => {
  it('points a shield onward to the Exchange and the Post Office', () => {
    expect(nextStepAfterIntents([shield])).toBe(COPY.next.afterShield);
    expect(COPY.next.afterShield).toBe('Next: swap at the Exchange or send from the Post Office.');
    expect(nextStepAfterIntents([shield, shield])).toBe(COPY.next.afterShield);
  });

  it('sends a swap on from the Post Office only when it bought STRK', () => {
    expect(nextStepAfterIntents([swapInto(STRK)])).toBe(COPY.next.afterSwap);
    expect(COPY.next.afterSwap).toBe('Next: send it privately from the Post Office.');
    // The Post Office sends the pool's STRK and nothing else.
    expect(nextStepAfterIntents([swapInto(ETH)])).toBeNull();
  });

  it('wraps a private transfer up gently', () => {
    expect(nextStepAfterIntents([transfer])).toBe(COPY.next.afterTransfer);
    expect(COPY.next.afterTransfer).not.toMatch(/^Next:/);
    expect(COPY.next.afterTransfer).toContain('sandbox');
  });

  it('wraps a stake up where the xSTRK lands, pointing nowhere else yet (D-063)', () => {
    const stake: Intent = {
      kind: 'stake',
      tokenIn: STRK,
      tokenOut: '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a',
      amountIn: 1n,
    };
    expect(nextStepAfterIntents([stake])).toBe(COPY.next.afterStake);
    expect(COPY.next.afterStake).toContain('pool balance');
    expect(nextStepAfterIntents([stake, transfer])).toBeNull();
  });

  it('says nothing it cannot say truthfully', () => {
    expect(nextStepAfterIntents([unshield])).toBeNull();
    expect(nextStepAfterIntents([transfer, unshield])).toBeNull();
    expect(nextStepAfterIntents([])).toBeNull();
    expect(nextStepAfterIntents([{ kind: 'lend' } as unknown as Intent])).toBeNull();
  });

  it('never walks the player up to a locked door', () => {
    const swapLocked = withRoute('exchange.swap', unapproved);
    expect(nextStepAfterIntents([shield], swapLocked)).toBe(COPY.next.afterShieldSend);
    // `post-office.transfer` is graded private, so only removal can shut it.
    const sendMissing = withRoute('post-office.transfer', null);
    expect(nextStepAfterIntents([shield], sendMissing)).toBe(COPY.next.afterShieldSwap);
    expect(nextStepAfterIntents([swapInto(STRK)], sendMissing)).toBeNull();
    const bothShut = withRoute('post-office.transfer', null).map((entry) =>
      entry.route === 'exchange.swap' ? { ...entry, ...unapproved } : entry,
    );
    expect(nextStepAfterIntents([shield], bothShut)).toBeNull();
  });

  it("puts D-021's return-to-pool hook before any onward step", () => {
    // Before D-023 a swap left its output in public. Were a route to do that
    // again, its register entry alone would turn its prompt back to the Bank.
    const publicSwap = withRoute('exchange.swap', { returnToPool: true });
    expect(nextStepAfterIntents([swapInto(ETH)], publicSwap)).toBe(COPY.next.shieldAtBank);
    const publicSwapShieldShut = publicSwap.map((entry) =>
      entry.route === 'bank.shield' ? { ...entry, ...unapproved } : entry,
    );
    expect(nextStepAfterIntents([swapInto(ETH)], publicSwapShieldShut)).toBeNull();
  });

  it('offers the Bridge arrival nudge only while the register funnels the Bridge back to an open shield', () => {
    expect(offersBridgeArrival()).toBe(true);
    expect(offersBridgeArrival(withRoute('bridge.deposit', { returnToPool: false }))).toBe(false);
    expect(offersBridgeArrival(withRoute('bank.shield', unapproved))).toBe(false);
  });

  it('carries the Bridge → Bank step as COPY, byte-identical to the string it replaced', () => {
    expect(COPY.next.shieldAtBank).toBe('Next: shield at the Bank');
    const bridgePanel = readFileSync(fileURLToPath(new URL('./bridge/BridgePanel.tsx', import.meta.url)), 'utf8');
    expect(bridgePanel).toContain('{COPY.next.shieldAtBank}');
    expect(bridgePanel).not.toContain('>Next: shield at the Bank<');
  });

  it('never calls the Bridge private in any journey copy', () => {
    const journey = JSON.stringify([COPY.hud, COPY.guide, COPY.next]);
    for (const line of journey.split('"').filter((part) => /bridge/i.test(part))) {
      expect(line, line).not.toMatch(/privat/i);
    }
    expect(COPY.next.bridgeArrival).toBe('Your bridged STRK arrived publicly — shield it at the Bank.');
  });
});
