import { describe, expect, it } from 'vitest';
import { hash } from 'starknet';
import { POOL_DEPOSIT_EVENT, STRK20_POOL, depositStatusFromReceipt } from './pool.js';

const ACCOUNT = '0x0123abc';
const OTHER = '0x0456def';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const TX = '0x05eed';

/** The shape `starknet_getTransactionReceipt` returned for a mainnet deposit on 2026-09-29 (RPC 0.10.2). */
function receipt(overrides: Record<string, unknown> = {}, events: unknown[] = [deposit()]): Record<string, unknown> {
  return {
    type: 'INVOKE',
    transaction_hash: TX,
    actual_fee: { amount: '0x1', unit: 'FRI' },
    execution_status: 'SUCCEEDED',
    finality_status: 'ACCEPTED_ON_L2',
    block_hash: '0x1',
    block_number: 1,
    messages_sent: [],
    events,
    execution_resources: {},
    ...overrides,
  };
}

/** The pool's event, as the node prints it: unpadded felts. */
function deposit(user = ACCOUNT, from = `0x${BigInt(STRK20_POOL).toString(16)}`): Record<string, unknown> {
  return { from_address: from, keys: [POOL_DEPOSIT_EVENT, user, STRK], data: ['0x1'] };
}

const expected = { transactionHash: TX, account: ACCOUNT };

describe('the pool constants (D-072)', () => {
  it("pins sn_keccak('Deposit') as the Deposit event's first key", () => {
    expect(BigInt(POOL_DEPOSIT_EVENT)).toBe(BigInt(hash.getSelectorFromName('Deposit')));
  });

  it('pins the canonical mainnet pool the backend is configured with', () => {
    expect(STRK20_POOL).toBe('0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a');
  });
});

describe('depositStatusFromReceipt (D-072)', () => {
  it('lands a succeeded, accepted receipt holding the pool Deposit for this account', () => {
    expect(depositStatusFromReceipt(receipt(), expected)).toBe('landed');
    expect(depositStatusFromReceipt(receipt({ finality_status: 'ACCEPTED_ON_L1' }), expected)).toBe('landed');
  });

  it('finds the deposit among the token and fee events around it', () => {
    const noise = { from_address: STRK, keys: ['0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9', ACCOUNT, STRK20_POOL], data: ['0x1', '0x0'] };
    expect(depositStatusFromReceipt(receipt({}, [noise, noise, deposit(), noise]), expected)).toBe('landed');
  });

  it('compares felts by value, whatever the padding or case', () => {
    const upper = deposit(`0x000${ACCOUNT.slice(2).toUpperCase()}`, STRK20_POOL.toUpperCase().replace('0X', '0x'));
    expect(depositStatusFromReceipt(receipt({ transaction_hash: '0x0005EED' }, [upper]), expected)).toBe('landed');
  });

  it('fails a reverted transaction once it is accepted', () => {
    expect(depositStatusFromReceipt(receipt({ execution_status: 'REVERTED', revert_reason: 'x' }, []), expected)).toBe('failed');
  });

  it('fails an accepted success with no deposit for this account', () => {
    expect(depositStatusFromReceipt(receipt({}, []), expected)).toBe('failed');
    expect(depositStatusFromReceipt(receipt({}, [deposit(OTHER)]), expected)).toBe('failed');
    // Another contract emitting an event with the same selector is not the pool.
    expect(depositStatusFromReceipt(receipt({}, [deposit(ACCOUNT, STRK)]), expected)).toBe('failed');
    const other = { ...deposit(), keys: ['0x1321a4', ACCOUNT, STRK] };
    expect(depositStatusFromReceipt(receipt({}, [other]), expected)).toBe('failed');
  });

  it('waits on a receipt the network has not accepted yet, however it executed', () => {
    for (const finality of ['PRE_CONFIRMED', 'RECEIVED', undefined, 7]) {
      expect(depositStatusFromReceipt(receipt({ finality_status: finality }), expected), String(finality)).toBe('pending');
      expect(depositStatusFromReceipt(receipt({ finality_status: finality, execution_status: 'REVERTED' }), expected)).toBe('pending');
    }
  });

  it('never reads a receipt for another transaction, or a malformed one, as landed', () => {
    for (const value of [
      null,
      undefined,
      'receipt',
      [receipt()],
      receipt({ transaction_hash: '0x5eee' }),
      receipt({ transaction_hash: undefined }),
      receipt({ transaction_hash: 'not-a-felt' }),
      receipt({ execution_status: 'UNKNOWN' }),
      receipt({ events: 'events' }),
      receipt({ events: { 0: deposit(), length: 1 } }),
    ]) {
      expect(depositStatusFromReceipt(value, expected)).toBe('pending');
    }
    expect(depositStatusFromReceipt(receipt({}, [null, 'event', { from_address: STRK20_POOL, keys: 'keys' }]), expected)).toBe('failed');
  });

  it('runs no getter or trap a hostile receipt defines', () => {
    let ran = false;
    const getter = receipt();
    Object.defineProperty(getter, 'execution_status', { get() { ran = true; return 'SUCCEEDED'; } });
    expect(depositStatusFromReceipt(getter, expected)).toBe('pending');
    expect(ran).toBe(false);

    const proxy = new Proxy(receipt(), { getOwnPropertyDescriptor() { throw new Error('trap'); } });
    expect(depositStatusFromReceipt(proxy, expected)).toBe('pending');

    const inherited = Object.assign(Object.create({ events: [deposit()] }), receipt(), {});
    delete (inherited as Record<string, unknown>).events;
    expect(depositStatusFromReceipt(inherited, expected)).toBe('pending');
  });

  it('refuses an event list longer than any pool transaction emits', () => {
    const events = Array.from({ length: 4_097 }, () => deposit());
    expect(depositStatusFromReceipt(receipt({}, events), expected)).toBe('pending');
  });

  it('needs a well-formed expected hash and account', () => {
    expect(depositStatusFromReceipt(receipt(), { transactionHash: 'nope', account: ACCOUNT })).toBe('pending');
    expect(depositStatusFromReceipt(receipt(), { transactionHash: TX, account: 'nope' })).toBe('failed');
  });
});
