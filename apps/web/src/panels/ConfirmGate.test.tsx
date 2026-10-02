import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Address, Intent } from '@strkworld/privacy';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { ConfirmGate } from './ConfirmGate.js';
import { ROUTE_BY_INTENT_KIND, disclosuresForIntents, findRoute } from './routes.js';

/**
 * The commit gate shows whatever pre-commit lines the register carries for
 * the batch, right above the button, and nothing when it carries none. The
 * lines are product copy (D-118): none of them is required, so an empty list
 * never blocks the button.
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

describe('ConfirmGate', () => {
  it('enables confirm for a route with no pre-commit line, and shows no list', () => {
    for (const intent of [stake, transfer]) {
      const entry = findRoute(ROUTE_BY_INTENT_KIND[intent.kind])!;
      expect(entry.disclosure, entry.route).toBeNull();
      expect(disclosuresForIntents([intent])).toEqual([]);
      const markup = gate([intent]);
      expect(confirmButton(markup), entry.route).not.toContain('disabled');
      expect(markup, entry.route).not.toContain('commit-disclosures');
    }
  });

  it('never blocks the button when a deviation carries no line (D-118)', () => {
    const register = withRoute('bank.unshield', { disclosure: null });
    const markup = gate([unshield], register);
    expect(confirmButton(markup)).not.toContain('disabled');
    expect(markup).not.toContain('commit-disclosures');
    expect(markup).not.toContain('role="alert"');
  });

  it('shows the line a route carries, right above the button', () => {
    for (const intent of [shield, unshield, swap]) {
      const entry = findRoute(ROUTE_BY_INTENT_KIND[intent.kind])!;
      if (!entry.disclosure) continue;
      const markup = gate([intent]);
      expect(markup, entry.route).toContain('data-testid="commit-disclosures"');
      expect(markup, entry.route).toContain(entry.disclosure.replaceAll("'", '&#x27;'));
      expect(markup.indexOf('commit-disclosures'), entry.route).toBeLessThan(markup.indexOf('class="confirm"'));
      expect(confirmButton(markup), entry.route).not.toContain('disabled');
    }
  });

  it('disables only while busy', () => {
    const markup = renderToStaticMarkup(
      <ConfirmGate disclosures={[]} busy onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(confirmButton(markup)).toContain('disabled');
  });
});
