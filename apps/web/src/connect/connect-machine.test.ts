import { describe, expect, it, vi } from 'vitest';
import {
  FakePrivacyOperations,
  PrivacyError,
  WalletApiPrivacyOperations,
  type PrivacyOperations,
  type WalletStrk20Account,
} from '@strkworld/privacy';
import { createConnectFlow, toWalletStatus } from './connect-machine.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('connect flow', () => {
  it('publishes an immutable flow API while retaining owned transitions', async () => {
    const flow = createConnectFlow(new FakePrivacyOperations());
    const originalDisconnect = flow.disconnect;

    expect(Object.isFrozen(flow)).toBe(true);
    expect(Reflect.set(flow, 'disconnect', () => undefined)).toBe(false);
    expect(Reflect.set(flow, 'recheck', async () => ({ name: 'disconnected' }))).toBe(false);
    expect(flow.disconnect).toBe(originalDisconnect);
    flow.disconnect();
    expect(flow.store.getState()).toEqual({ name: 'disconnected' });
  });

  it('keeps the public connection state read-only and immutable', async () => {
    const flow = createConnectFlow(new FakePrivacyOperations());

    expect('setState' in flow.store).toBe(false);
    expect(Object.isFrozen(flow.store.getState())).toBe(true);

    const state = await flow.connect();
    if (state.name !== 'connected') throw new Error('expected a connected wallet');
    expect(flow.store.getState()).toBe(state);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.capability)).toBe(true);
    expect(Reflect.set(state, 'name', 'disconnected')).toBe(false);
    expect(Reflect.set(state.capability, 'supportsStrk20', false)).toBe(false);
    expect(flow.store.getState()).toMatchObject({
      name: 'connected',
      capability: { supportsStrk20: true },
    });
  });

  it('starts disconnected and reports it to the world', () => {
    const flow = createConnectFlow(new FakePrivacyOperations());
    expect(flow.store.getState().name).toBe('disconnected');
    expect(flow.status()).toBe('disconnected');
  });

  it('reaches connected when the wallet supports STRK20 and is registered', async () => {
    const flow = createConnectFlow(new FakePrivacyOperations());
    const state = await flow.connect();
    expect(state.name).toBe('connected');
    expect(state.name === 'connected' && state.registrationConfirmed).toBe(true);
    expect(flow.status()).toBe('connected');
  });

  it('routes a wallet without STRK20 to the unsupported room, not an error', async () => {
    const operations = new FakePrivacyOperations({
      capability: { supportsStrk20: false, walletApiVersion: '0.9.0' },
    });
    const flow = createConnectFlow(operations);
    const state = await flow.connect();

    expect(state.name).toBe('unsupported-wallet');
    expect(state.name === 'unsupported-wallet' && state.walletApiVersion).toBe('0.9.0');
    expect(flow.status()).toBe('unsupported');
  });

  it('marks a reported version below the required one as too old', async () => {
    const flow = createConnectFlow(new FakePrivacyOperations({
      capability: { supportsStrk20: false, walletApiVersion: '0.9.0' },
    }));
    expect(await flow.connect()).toEqual({ name: 'unsupported-wallet', walletApiVersion: '0.9.0', versionTooOld: true });
  });

  it('does not call a wallet with no parseable version too old', async () => {
    const flow = createConnectFlow(new FakePrivacyOperations({
      capability: { supportsStrk20: false, walletApiVersion: null },
    }));
    expect(await flow.connect()).toEqual({ name: 'unsupported-wallet', walletApiVersion: null });
  });

  it('admits a wallet with the base STRK20 methods but no shadow accounts', async () => {
    const flow = createConnectFlow(new FakePrivacyOperations({
      capability: { supportsStrk20: true, walletApiVersion: '0.10.3', supportsShadowAccounts: false },
    }));
    expect(await flow.connect()).toMatchObject({
      name: 'connected',
      capability: { supportsStrk20: true, supportsShadowAccounts: false },
    });
  });

  describe('a capability probe that fails, through the Wallet API adapter', () => {
    function flowFailing(failure: unknown) {
      const wallet = {
        address: '0xabc',
        strk20Balances: vi.fn(),
        strk20PrepareInvoke: vi.fn(),
        strk20InvokeTransaction: vi.fn(),
      } as unknown as WalletStrk20Account;
      const operations = new WalletApiPrivacyOperations({
        wallet,
        pool: {} as never,
        supportedVersions: async () => { throw failure; },
        policy: {
          maxIntents: 1,
          maxRelayFee: 0n,
          enabledRoutes: [],
          allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
        },
      });
      return { flow: createConnectFlow(operations), wallet };
    }

    it.each([
      ['-32601 method not found', { code: -32601, message: 'Method not found' }],
      ['"Not implemented"', new Error('Not implemented')],
      ['"Unknown method"', new Error('Unknown method')],
      ['162', { code: 162, message: 'An error occurred (API_VERSION_NOT_SUPPORTED)' }],
    ] as const)('sends a wallet that answers %s to the unsupported room, not "Cannot reach your wallet"', async (_label, failure) => {
      const { flow, wallet } = flowFailing(failure);
      expect(await flow.connect()).toEqual({ name: 'unsupported-wallet', walletApiVersion: null });
      expect(flow.status()).toBe('unsupported');
      expect(wallet.strk20Balances).not.toHaveBeenCalled();
    });

    it.each([
      ['a dropped transport', new TypeError('Failed to fetch')],
      ['a timeout', new Error('Request timed out')],
      ['a popup closed without a code', new Error('User closed the popup')],
    ] as const)('keeps %s in the unreachable room, with its retry', async (_label, failure) => {
      const { flow } = flowFailing(failure);
      expect(await flow.connect()).toEqual({ name: 'unreachable' });
    });

    it('sends a declined probe back to the connect room', async () => {
      const { flow } = flowFailing({ code: 113, message: 'User rejected' });
      expect(await flow.connect()).toEqual({ name: 'disconnected' });
    });
  });

  it('routes an unregistered account to not-registered, which admits it to the entry gate (D-072)', async () => {
    const operations = new FakePrivacyOperations({ capability: { registration: 'unregistered' } });
    const flow = createConnectFlow(operations);

    expect((await flow.connect()).name).toBe('not-registered');
    expect(flow.status()).toBe('unregistered');
  });

  it('connects with registration unknown rather than probing for it', async () => {
    const operations = new FakePrivacyOperations({ capability: { registration: 'unknown' } });
    const balances = vi.spyOn(operations, 'balances');
    const flow = createConnectFlow(operations);

    const state = await flow.connect();
    expect(state.name).toBe('connected');
    expect(state.name === 'connected' && state.registrationConfirmed).toBe(false);
    // A balance read raises a wallet approval, so it is never a capability probe.
    expect(balances).not.toHaveBeenCalled();
  });

  it('escalates a 118 from a later operation into not-registered, whose card a building shows (D-072)', async () => {
    const flow = createConnectFlow(new FakePrivacyOperations());
    await flow.connect();

    flow.noteOperationError(new PrivacyError('not-registered', 'error 118'));
    expect(flow.store.getState().name).toBe('not-registered');
    expect(flow.status()).toBe('unregistered');
  });

  it('comes back from a 118 after entry on the card\'s recheck, with no balance read (D-072)', async () => {
    const operations = new FakePrivacyOperations();
    const balances = vi.spyOn(operations, 'balances');
    const flow = createConnectFlow(operations);
    await flow.connect();
    flow.noteOperationError(new PrivacyError('not-registered', 'error 118'));

    expect((await flow.recheck()).name).toBe('connected');
    expect(flow.status()).toBe('connected');
    expect(balances).not.toHaveBeenCalled();
  });

  it('escalates a 162 into the unsupported room', async () => {
    const flow = createConnectFlow(new FakePrivacyOperations());
    await flow.connect();

    flow.noteOperationError(new PrivacyError('unsupported-wallet', 'error 162'));
    expect(flow.store.getState().name).toBe('unsupported-wallet');
  });

  it('leaves the room alone for failures that are about the action, not the account', async () => {
    const flow = createConnectFlow(new FakePrivacyOperations());
    await flow.connect();

    flow.noteOperationError(new PrivacyError('insufficient-balance', 'error 119'));
    flow.noteOperationError(new PrivacyError('unreachable', 'network'));
    flow.noteOperationError(new Error('not a privacy error'));
    expect(flow.store.getState().name).toBe('connected');
  });

  it('never escalates a transfer recipient\'s 118: it is about the recipient, not this account (D-074)', async () => {
    const flow = createConnectFlow(new FakePrivacyOperations());
    const connected = await flow.connect();
    const published = vi.fn();
    flow.store.subscribe(published);

    // As the seam throws it, and as a panel hands it on after classifying it.
    expect(flow.noteOperationError(new PrivacyError('recipient-not-registered', 'error 118 on a transfer')))
      .toBe(connected);
    expect(flow.noteOperationError({ kind: 'recipient-not-registered', cause: { code: 118 } })).toBe(connected);

    expect(flow.store.getState()).toBe(connected);
    expect(flow.status()).toBe('connected');
    expect(published).not.toHaveBeenCalled();
  });

  it('does not retire a capability query in flight for a recipient\'s 118, as it does for the account\'s own (D-074)', async () => {
    const capability = deferred<Awaited<ReturnType<PrivacyOperations['capability']>>>();
    const operations = new FakePrivacyOperations();
    vi.spyOn(operations, 'capability').mockReturnValue(capability.promise);
    const flow = createConnectFlow(operations);

    const pending = flow.connect();
    flow.noteOperationError(new PrivacyError('recipient-not-registered', 'error 118 on a transfer'));
    expect(flow.store.getState().name).toBe('detecting');
    capability.resolve({ supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'registered' });

    expect(await pending).toMatchObject({ name: 'connected' });
    expect(flow.store.getState()).toMatchObject({ name: 'connected' });
  });

  it('treats a declined connection as disconnected, not as a failure', async () => {
    const operations = new FakePrivacyOperations();
    operations.injectFault({ kind: 'user-rejected', on: 'capability' });
    const flow = createConnectFlow(operations);

    expect((await flow.connect()).name).toBe('disconnected');
  });

  it('surfaces an unreachable wallet and recovers on recheck', async () => {
    const operations = new FakePrivacyOperations();
    operations.injectFault({ kind: 'unreachable', on: 'capability' });
    const flow = createConnectFlow(operations);

    expect((await flow.connect()).name).toBe('unreachable');
    expect(flow.status()).toBe('disconnected');
    expect((await flow.recheck()).name).toBe('connected');
  });

  it('retries after capability throws synchronously before returning a promise', async () => {
    const operations = new FakePrivacyOperations();
    const capability = vi.spyOn(operations, 'capability')
      .mockImplementationOnce(() => {
        throw new PrivacyError('unreachable', 'synchronous adapter failure');
      })
      .mockResolvedValueOnce({
        supportsStrk20: true,
        walletApiVersion: '0.10.3',
        registration: 'registered',
      });
    const flow = createConnectFlow(operations);

    expect((await flow.connect()).name).toBe('unreachable');
    expect((await flow.recheck()).name).toBe('connected');
    expect(capability).toHaveBeenCalledTimes(2);
  });

  it('recheck moves a registered player out of not-registered', async () => {
    const operations = new FakePrivacyOperations({ capability: { registration: 'unregistered' } });
    const flow = createConnectFlow(operations);
    expect((await flow.connect()).name).toBe('not-registered');

    const registered = new FakePrivacyOperations();
    const second = createConnectFlow(registered);
    expect((await second.recheck()).name).toBe('connected');
  });

  it('shares one in-flight capability query between concurrent callers', async () => {
    const operations = new FakePrivacyOperations({ latencyMs: 5 });
    const capability = vi.spyOn(operations, 'capability');
    const flow = createConnectFlow(operations);

    await Promise.all([flow.connect(), flow.connect(), flow.connect()]);
    expect(capability).toHaveBeenCalledTimes(1);
  });

  it('stays disconnected when a capability query resolves after disconnect', async () => {
    const capability = deferred<Awaited<ReturnType<PrivacyOperations['capability']>>>();
    const operations = new FakePrivacyOperations();
    vi.spyOn(operations, 'capability').mockReturnValue(capability.promise);
    const flow = createConnectFlow(operations);

    const pending = flow.connect();
    flow.disconnect();
    capability.resolve({ supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'registered' });

    const result = await pending;
    expect(result).toEqual({ name: 'disconnected' });
    expect(flow.store.getState()).toEqual({ name: 'disconnected' });
    expect(flow.status()).toBe('disconnected');
  });

  it('stays disconnected when a capability query rejects after disconnect', async () => {
    const capability = deferred<Awaited<ReturnType<PrivacyOperations['capability']>>>();
    const operations = new FakePrivacyOperations();
    vi.spyOn(operations, 'capability').mockReturnValue(capability.promise);
    const flow = createConnectFlow(operations);

    const pending = flow.connect();
    flow.disconnect();
    capability.reject(new PrivacyError('unreachable', 'stale network failure'));

    const result = await pending;
    expect(result).toEqual({ name: 'disconnected' });
    expect(flow.store.getState()).toEqual({ name: 'disconnected' });
    expect(flow.status()).toBe('disconnected');
  });

  it('starts a fresh attempt after disconnect and lets it win over the stale attempt', async () => {
    const firstCapability = deferred<Awaited<ReturnType<PrivacyOperations['capability']>>>();
    const secondCapability = deferred<Awaited<ReturnType<PrivacyOperations['capability']>>>();
    const operations = new FakePrivacyOperations();
    const capability = vi.spyOn(operations, 'capability')
      .mockReturnValueOnce(firstCapability.promise)
      .mockReturnValueOnce(secondCapability.promise);
    const flow = createConnectFlow(operations);

    const first = flow.connect();
    flow.disconnect();
    const second = flow.connect();
    expect(second).not.toBe(first);
    expect(capability).toHaveBeenCalledTimes(2);

    secondCapability.resolve({ supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'registered' });
    const secondResult = await second;
    expect(secondResult).toEqual({
      name: 'connected',
      capability: { supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'registered' },
      registrationConfirmed: true,
    });
    expect(flow.store.getState()).toMatchObject({
      name: 'connected',
      capability: { walletApiVersion: '0.10.3' },
    });

    firstCapability.reject(new PrivacyError('unreachable', 'stale network failure'));
    const firstResult = await first;
    expect(firstResult).toEqual(secondResult);
    expect(flow.store.getState()).toMatchObject({
      name: 'connected',
      capability: { walletApiVersion: '0.10.3' },
    });
    expect(flow.status()).toBe('connected');
  });

  it.each([
    ['not-registered', new PrivacyError('not-registered', 'error 118')],
    ['unsupported-wallet', new PrivacyError('unsupported-wallet', 'error 162')],
  ] as const)(
    'keeps a newer %s operation verdict when an older capability query settles',
    async (expected, operationError) => {
      const capability = deferred<Awaited<ReturnType<PrivacyOperations['capability']>>>();
      const operations = new FakePrivacyOperations();
      vi.spyOn(operations, 'capability').mockReturnValue(capability.promise);
      const flow = createConnectFlow(operations);

      const pending = flow.connect();
      flow.noteOperationError(operationError);
      capability.resolve({
        supportsStrk20: true,
        walletApiVersion: '0.10.3',
        registration: 'registered',
      });

      expect(await pending).toMatchObject({ name: expected });
      expect(flow.store.getState()).toMatchObject({ name: expected });
    },
  );

  it('does not let an older query release a recheck started after an operation verdict', async () => {
    const firstCapability = deferred<Awaited<ReturnType<PrivacyOperations['capability']>>>();
    const secondCapability = deferred<Awaited<ReturnType<PrivacyOperations['capability']>>>();
    const unexpectedThird = deferred<Awaited<ReturnType<PrivacyOperations['capability']>>>();
    const operations = new FakePrivacyOperations();
    const capability = vi.spyOn(operations, 'capability')
      .mockReturnValueOnce(firstCapability.promise)
      .mockReturnValueOnce(secondCapability.promise)
      .mockReturnValueOnce(unexpectedThird.promise);
    const flow = createConnectFlow(operations);

    const older = flow.connect();
    flow.noteOperationError(new PrivacyError('not-registered', 'newer operation verdict'));
    const recheck = flow.recheck();

    firstCapability.resolve({
      supportsStrk20: true,
      walletApiVersion: '0.10.3',
      registration: 'registered',
    });
    await older;

    const shared = flow.connect();
    expect(capability).toHaveBeenCalledTimes(2);

    secondCapability.resolve({
      supportsStrk20: true,
      walletApiVersion: '0.10.3',
      registration: 'registered',
    });
    unexpectedThird.resolve({
      supportsStrk20: true,
      walletApiVersion: '0.10.3',
      registration: 'registered',
    });
    await expect(Promise.all([recheck, shared])).resolves.toEqual([
      expect.objectContaining({ name: 'connected' }),
      expect.objectContaining({ name: 'connected' }),
    ]);
  });

  it('passes detecting through to the world as connecting', () => {
    expect(toWalletStatus({ name: 'detecting' })).toBe('connecting');
  });
});
