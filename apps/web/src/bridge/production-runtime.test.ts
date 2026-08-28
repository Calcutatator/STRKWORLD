import { describe, expect, it, vi } from 'vitest';
import { BridgeService, type OneClickClient } from '@strkworld/bridge';
import { createProductionBridgeRuntime } from './production-runtime.js';

describe('production Bridge runtime', () => {
  it('admits usable persistent storage without contacting 1Click', async () => {
    const storage = fakeStorage();
    const client = fakeClient();

    const runtime = createProductionBridgeRuntime({ client, storage });

    expect(runtime?.service).toBeInstanceOf(BridgeService);
    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(storage.removeItem).toHaveBeenCalledOnce();
    expect(client.getTokens).not.toHaveBeenCalled();
    expect(client.getQuote).not.toHaveBeenCalled();
    expect(client.getExecutionStatus).not.toHaveBeenCalled();
    expect(client.submitDepositTx).not.toHaveBeenCalled();

    expect(runtime?.service.resume()).toBeNull();
    expect(client.getTokens).not.toHaveBeenCalled();

    const sources = await runtime!.loadSources();
    expect(client.getTokens).toHaveBeenCalledOnce();
    expect(sources).toContainEqual(expect.objectContaining({
      assetId: 'nep141:arb-usdc.omft.near',
      symbol: 'USDC',
      chainName: 'arbitrum',
      availability: 'live',
    }));
  });

  it.each([
    ['read', 'getItem'],
    ['write', 'setItem'],
    ['remove', 'removeItem'],
  ] as const)('fails only Bridge recovery when persistent storage cannot %s', (_phase, method) => {
    const storage = fakeStorage();
    storage[method].mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    const client = fakeClient();

    expect(createProductionBridgeRuntime({ client, storage })).toBeNull();
    expect(client.getTokens).not.toHaveBeenCalled();
    expect(client.getQuote).not.toHaveBeenCalled();
    expect(client.getExecutionStatus).not.toHaveBeenCalled();
    expect(client.submitDepositTx).not.toHaveBeenCalled();
  });

  it('creates separate service owners while retaining explicit shared browser storage', () => {
    const storage = fakeStorage();
    const first = createProductionBridgeRuntime({ client: fakeClient(), storage });
    const second = createProductionBridgeRuntime({ client: fakeClient(), storage });

    expect(first?.service).not.toBe(second?.service);
    expect(first?.service.resume()).toBeNull();
    expect(second?.service.resume()).toBeNull();
  });
});

function fakeClient(): OneClickClient {
  return {
    getTokens: vi.fn(async () => [{
      assetId: 'nep141:arb-usdc.omft.near',
      blockchain: 'arb',
      symbol: 'USDC',
      decimals: 6,
    }]),
    getQuote: vi.fn(async () => { throw new Error('not called'); }),
    getExecutionStatus: vi.fn(async () => { throw new Error('not called'); }),
    submitDepositTx: vi.fn(async () => { throw new Error('not called'); }),
  } as unknown as OneClickClient;
}

function fakeStorage(): Storage & {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
} {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  };
}
