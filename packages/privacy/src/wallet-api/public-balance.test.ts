import { describe, expect, it, vi } from 'vitest';
import { hash } from 'starknet';
import { RpcPublicBalanceReader } from './public-balance.js';
import { shieldDeposits } from '../shield-deposit.js';
import { FakePrivacyOperations } from '../testing/fake.js';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const ACCOUNT = '0x0123abc';
const ONE = 10n ** 18n;
const FEE = 6n * ONE;

function answering(result: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
  }) as Response);
}

describe('RpcPublicBalanceReader (D-094)', () => {
  it("calls the token's balance_of for the account over the wallet's RPC, and joins the u256", async () => {
    const fetch = answering([`0x${(29n * ONE).toString(16)}`, '0x0']);
    const reader = new RpcPublicBalanceReader('https://rpc.example', { fetch });
    await expect(reader.read(STRK, ACCOUNT)).resolves.toBe(29n * ONE);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://rpc.example');
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      method: 'starknet_call',
      params: [{ contract_address: STRK, entry_point_selector: hash.getSelectorFromName('balance_of'), calldata: [ACCOUNT] }, 'latest'],
    });
  });

  it('adds the high word of the u256', async () => {
    const reader = new RpcPublicBalanceReader('https://rpc.example', { fetch: answering(['0x1', '0x2']) });
    await expect(reader.read(STRK, ACCOUNT)).resolves.toBe(1n + 2n * (1n << 128n));
  });

  it('fails as unreachable on a malformed answer or a failed request, naming no address', async () => {
    for (const result of [['0x1'], ['0x1', 'nope'], [`0x${(1n << 128n).toString(16)}`, '0x0'], null]) {
      const reader = new RpcPublicBalanceReader('https://rpc.example', { fetch: answering(result) });
      await expect(reader.read(STRK, ACCOUNT)).rejects.toMatchObject({ kind: 'unreachable' });
    }
    const down = new RpcPublicBalanceReader('https://rpc.example', {
      fetch: async () => ({ ok: false, status: 503, text: async () => '' }) as Response,
    });
    const error = await down.read(STRK, ACCOUNT).catch((caught: Error) => caught);
    expect(error).toMatchObject({ kind: 'unreachable' });
    expect(String((error as Error).message)).not.toContain(ACCOUNT);
  });

  it('needs an https RPC and real addresses', async () => {
    expect(() => new RpcPublicBalanceReader('http://rpc.example')).toThrow(/https/);
    const reader = new RpcPublicBalanceReader('https://rpc.example', { fetch: answering(['0x0', '0x0']) });
    await expect(reader.read('STRK', ACCOUNT)).rejects.toMatchObject({ kind: 'unknown' });
  });
});

describe('shieldDeposits (D-094): the pool fee goes on top of a shield', () => {
  const pool = { feeToken: STRK, feeAmount: FEE };

  it('deposits amount + fee for a STRK shield, so the note is the amount', () => {
    expect(shieldDeposits([{ kind: 'shield', token: STRK, amount: 9n * ONE }], pool)).toEqual([15n * ONE]);
  });

  it('charges the fee once per transaction, on the first STRK shield', () => {
    expect(shieldDeposits([
      { kind: 'shield', token: STRK, amount: 9n * ONE },
      { kind: 'shield', token: STRK, amount: 1n * ONE },
    ], pool)).toEqual([15n * ONE, 1n * ONE]);
  });

  it('adds nothing to another token, whose share of the STRK fee cannot be stated', () => {
    expect(shieldDeposits([{ kind: 'shield', token: USDC, amount: 7n }], pool)).toEqual([7n]);
    expect(shieldDeposits([
      { kind: 'shield', token: USDC, amount: 7n },
      { kind: 'shield', token: STRK, amount: ONE },
    ], pool)).toEqual([7n, ONE + FEE]);
  });
});

describe('the fake wallet pays a shield and its fee from its public balance (D-094)', () => {
  it('debits amount + fee and credits the amount to the pool', async () => {
    const fake = new FakePrivacyOperations({ publicBalances: { [STRK]: 29n * ONE } });
    const batch = await fake.prepare([{ kind: 'shield', token: STRK, amount: 9n * ONE }]);
    await batch.confirm({ feeCeiling: batch.totalCost });
    expect(await fake.publicBalance(STRK)).toBe(14n * ONE);
    const [entry] = await fake.balances([STRK]);
    expect(entry!.total).toBe(9n * ONE);
  });

  it('refuses a shield the public balance cannot pay for with its fee', async () => {
    const fake = new FakePrivacyOperations({ publicBalances: { [STRK]: 14n * ONE } });
    const batch = await fake.prepare([{ kind: 'shield', token: STRK, amount: 9n * ONE }]);
    await expect(batch.confirm({ feeCeiling: batch.totalCost })).rejects.toMatchObject({ kind: 'insufficient-balance' });
    expect(await fake.publicBalance(STRK)).toBe(14n * ONE);
  });
});
