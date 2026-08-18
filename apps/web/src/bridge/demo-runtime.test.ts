import { describe, expect, it } from 'vitest';
import { createDemoBridgeRuntime } from './demo-runtime.js';
import { createBridgePanel } from './bridge-machine.js';

describe('demo Bridge runtime', () => {
  it('uses fixed offline quote/status fixtures and reaches a validated settled amount', async () => {
    const runtime = await createDemoBridgeRuntime();
    const assets = await runtime.loadSources();
    const source = assets[0]!;
    const service = runtime.service!;
    const record = await service.createManualDeposit({
      source,
      amountIn: 1_000_000n,
      starknetRecipient: runtime.account!,
      refundAddress: '0x1111111111111111111111111111111111111111',
    });
    expect(record.status.leg).toBe('awaiting-deposit');
    await expect(service.refresh()).resolves.toMatchObject({ leg: 'awaiting-deposit' });
    await expect(service.refresh()).resolves.toMatchObject({ leg: 'settled', strkReceived: 18_500_000_000_000_000_000n });
    expect(runtime.available()).toBe(true);
  });

  it('composes the fixed clock into the shell machine so demo instructions are usable', async () => {
    const runtime = await createDemoBridgeRuntime();
    const assets = await runtime.loadSources();
    const machine = createBridgePanel({
      service: runtime.service!,
      loadSources: runtime.loadSources,
      readAccount: runtime.readAccount,
      planner: runtime.planner,
      now: runtime.now,
    });
    await machine.createQuote({ source: assets[0]!, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    expect(machine.store.getState().instructionsVisible).toBe(true);
    expect(machine.store.getState().record?.signedQuote.quote.depositAddress).toBe('0x1111111111111111111111111111111111111111');
  });
});
