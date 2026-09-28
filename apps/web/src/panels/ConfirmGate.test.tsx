import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Address, Intent } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { ConfirmGate } from './ConfirmGate.js';
import { ROUTE_BY_INTENT_KIND, batchRequiresDisclosure, disclosuresForIntents, findRoute } from './routes.js';

/**
 * The commit gate and the narrow waivers of D-064 (staking) and D-065 (the
 * transfer).
 *
 * Every panel feeds `ConfirmGate` the same two derived facts — the batch's
 * approved disclosures and whether it needs any — so the gate is exercised
 * here exactly as the Bank, Exchange and Post Office wire it.
 */

const STRK: Address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const XSTRK: Address = '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';
const ETH: Address = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
const BOB: Address = '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';

const stake: Intent = { kind: 'stake', tokenIn: STRK, tokenOut: XSTRK, amountIn: 5n };
const transfer: Intent = { kind: 'transfer', token: STRK, amount: 5n, recipient: BOB };
const shield: Intent = { kind: 'shield', token: STRK, amount: 5n };
const unshield: Intent = { kind: 'unshield', token: STRK, amount: 5n, recipient: BOB };
const swap: Intent = { kind: 'swap', tokenIn: STRK, tokenOut: ETH, amountIn: 5n, minAmountOut: 1n };

function withRoute(route: string, change: Partial<RouteGrade>): readonly RouteGrade[] {
  return PRIVACY_REGISTER.map((entry) => (entry.route === route ? { ...entry, ...change } : entry));
}

function gate(intents: readonly Intent[], register: readonly RouteGrade[] = PRIVACY_REGISTER): string {
  return renderToStaticMarkup(
    <ConfirmGate
      disclosures={disclosuresForIntents(intents, register)}
      requiresDisclosure={batchRequiresDisclosure(intents, register)}
      busy={false}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
}

function confirmButton(markup: string): string {
  const found = markup.match(/<button[^>]*class="confirm"[^>]*>/)?.[0];
  if (!found) throw new Error('no confirm button');
  return found;
}

describe('ConfirmGate under the D-064 and D-065 waivers', () => {
  it('enables confirm for the waived stake route, with no disclosure to show', () => {
    expect(batchRequiresDisclosure([stake])).toBe(false);
    expect(disclosuresForIntents([stake])).toEqual([]);

    const markup = gate([stake]);
    expect(confirmButton(markup)).not.toContain('disabled');
    expect(markup).not.toContain('commit-disclosures');
    expect(markup).not.toContain('confirm-blocked');
  });

  it('still refuses an undisclosed deviation that no decision waived', () => {
    // The approved copy dropped somewhere between the register and the screen.
    const register = withRoute('bank.unshield', { disclosure: null });

    expect(batchRequiresDisclosure([unshield], register)).toBe(true);
    const markup = gate([unshield], register);
    expect(confirmButton(markup)).toContain('disabled');
    expect(markup).toContain('class="confirm-blocked"');
    expect(markup).toContain(COPY.notices.disclosureMissing);
  });

  it('refuses the stake as well once its waiver is gone: the waiver, not the grade, opens the gate', () => {
    for (const waiver of [null, '', 'waived', 'D-64']) {
      const register = withRoute('bank.stake', { disclosureWaivedBy: waiver });
      expect(batchRequiresDisclosure([stake], register), String(waiver)).toBe(true);
      expect(confirmButton(gate([stake], register)), String(waiver)).toContain('disabled');
    }
    // An unknown route is never "nothing to disclose".
    const withoutStake = PRIVACY_REGISTER.filter((entry) => entry.route !== 'bank.stake');
    expect(confirmButton(gate([stake], withoutStake))).toContain('disabled');
  });

  it('enables confirm for the transfer under D-065, graded anonymous with its disclosure waived', () => {
    const entry = findRoute(ROUTE_BY_INTENT_KIND.transfer)!;
    expect(entry).toMatchObject({ grade: 'anonymous', disclosure: null, disclosureWaivedBy: 'D-065' });
    expect(batchRequiresDisclosure([transfer])).toBe(false);
    expect(disclosuresForIntents([transfer])).toEqual([]);

    const markup = gate([transfer]);
    expect(confirmButton(markup)).not.toContain('disabled');
    expect(markup).not.toContain('commit-disclosures');
    expect(markup).not.toContain('confirm-blocked');
  });

  it('refuses the transfer once its waiver is gone or borrowed: the waiver, not the grade, opens the gate', () => {
    for (const waiver of [null, '', 'D-064', 'D-65']) {
      const register = withRoute('post-office.transfer', { disclosureWaivedBy: waiver });
      expect(batchRequiresDisclosure([transfer], register), String(waiver)).toBe(true);
      const markup = gate([transfer], register);
      expect(confirmButton(markup), String(waiver)).toContain('disabled');
      expect(markup, String(waiver)).toContain(COPY.notices.disclosureMissing);
    }
    // An unknown route is never "nothing to disclose".
    const withoutTransfer = PRIVACY_REGISTER.filter((entry) => entry.route !== 'post-office.transfer');
    expect(confirmButton(gate([transfer], withoutTransfer))).toContain('disabled');
  });

  it('is no blanket switch: every other deviation still shows its own disclosure at the gate', () => {
    for (const intent of [shield, unshield, swap]) {
      const entry = findRoute(ROUTE_BY_INTENT_KIND[intent.kind])!;
      expect(entry.grade, entry.route).not.toBe('private');
      expect(entry.disclosureWaivedBy ?? null, entry.route).toBeNull();
      expect(batchRequiresDisclosure([intent]), entry.route).toBe(true);

      const markup = gate([intent]);
      expect(markup, entry.route).toContain('data-testid="commit-disclosures"');
      expect(markup, entry.route).toContain(entry.disclosure!.replaceAll("'", '&#x27;'));
      expect(confirmButton(markup), entry.route).not.toContain('disabled');
    }
  });
});
