import { describe, expect, it, vi } from 'vitest';
import type { PreparedBatch, PrivacyOperations } from '../operations.js';
import { FakePrivacyOperations } from '../testing/fake.js';
import { PrivacyError } from '../types.js';
import {
  createProductionWalletSession,
  createWalletSession,
  type WalletConnectionPort,
  type WalletDiscoveryPort,
  type WalletHandle,
} from './session.js';

describe('WalletSession', () => {
  it('shares same-key connection attempts instead of opening duplicate wallet workflows', async () => {
    const selected = wallet('Ready');
    let release!: (connection: WalletConnectionPort) => void;
    const pending = new Promise<WalletConnectionPort>((resolve) => { release = resolve; });
    const connectWallet = vi.fn(() => pending);
    const session = createWalletSession(denyAllOptions(), {
      discovery: discoveryWith(selected),
      connectWallet,
    });
    const choice = session.getSnapshot().wallets[0]!;

    const first = session.connect(choice.key);
    const second = session.connect(choice.key);

    expect(connectWallet).toHaveBeenCalledOnce();
    release(connection('0x111'));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', account: '0x111' });
  });

  it('rejects a connection snapshot whose authority fields are inherited', async () => {
    const selected = wallet('Ready');
    const port = connection('0x111');
    port.getSnapshot = () => Object.create({
      account: '0x111',
      chainId: '0x534e5f4d41494e',
    }) as never;
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => port },
    );

    await expect(session.connect(session.getSnapshot().wallets[0]!.key)).rejects.toMatchObject({ kind: 'unknown' });
    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', account: null });
  });

  it('does not invoke an accessor-backed connection snapshot field', async () => {
    const selected = wallet('Ready');
    const port = connection('0x111');
    const snapshot = { account: '0x111', chainId: '0x534e5f4d41494e' } as {
      account: string;
      chainId: string;
    };
    Object.defineProperty(snapshot, 'account', {
      configurable: true,
      get() { throw new Error('connection account getter must not run'); },
    });
    port.getSnapshot = () => snapshot;
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => port },
    );

    await expect(session.connect(session.getSnapshot().wallets[0]!.key)).rejects.toMatchObject({ kind: 'unknown' });
    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', account: null });
  });

  it('starts a fresh same-key connection after disconnect retires a pending one', async () => {
    const selected = wallet('Ready');
    let releaseFirst!: (connection: WalletConnectionPort) => void;
    let releaseSecond!: (connection: WalletConnectionPort) => void;
    const first = new Promise<WalletConnectionPort>((resolve) => { releaseFirst = resolve; });
    const second = new Promise<WalletConnectionPort>((resolve) => { releaseSecond = resolve; });
    const connectWallet = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const session = createWalletSession(denyAllOptions(), {
      discovery: discoveryWith(selected),
      connectWallet,
    });
    const choice = session.getSnapshot().wallets[0]!;

    const stale = session.connect(choice.key);
    const disconnecting = session.disconnect();
    const current = session.connect(choice.key);
    releaseFirst(connection('0x111'));
    releaseSecond(connection('0x222'));

    await disconnecting;
    await stale;
    await expect(current).resolves.toMatchObject({ phase: 'connected', account: '0x222' });
    expect(connectWallet).toHaveBeenCalledTimes(2);
  });

  it('preserves the retired snapshot when stale connection cleanup throws', async () => {
    const selected = wallet('Ready');
    let release!: (connection: WalletConnectionPort) => void;
    const pending = new Promise<WalletConnectionPort>((resolve) => { release = resolve; });
    const stale = connection('0x111');
    const destroy = vi.fn(() => { throw new Error('stale cleanup failed'); });
    stale.destroy = destroy;
    const session = createWalletSession(denyAllOptions(), {
      discovery: discoveryWith(selected),
      connectWallet: () => pending,
    });
    const connecting = session.connect(session.getSnapshot().wallets[0]!.key);

    await session.disconnect();
    release(stale);

    await expect(connecting).resolves.toMatchObject({ phase: 'selection-required' });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('preserves the mapped connection error when snapshot read and cleanup throw', async () => {
    const selected = wallet('Ready');
    const connected = connection('0x111');
    const original = new Error('wallet snapshot unavailable');
    connected.getSnapshot = () => { throw original; };
    const destroy = vi.fn(() => { throw new Error('cleanup failed'); });
    connected.destroy = destroy;
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected },
    );

    await expect(session.connect(session.getSnapshot().wallets[0]!.key)).rejects.toMatchObject({
      kind: 'unreachable',
    });
    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', account: null });
    await expect(session.operations.capability()).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('publishes disconnected state when explicit unsubscribe cleanup throws', async () => {
    const selected = wallet('Ready');
    const connected = controllableConnection(
      '0x111',
      new FakePrivacyOperations(),
      new FakePrivacyOperations(),
    );
    const cleanupError = new Error('unsubscribe failed');
    connected.port.subscribe = () => () => { throw cleanupError; };
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);

    await expect(session.disconnect()).rejects.toBe(cleanupError);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'selection-required',
      selectedKey: null,
      account: null,
    });
    await expect(session.operations.capability()).rejects.toMatchObject({ kind: 'user-rejected' });
  });

  it('publishes disconnected state when explicit destroy cleanup throws', async () => {
    const selected = wallet('Ready');
    const connected = controllableConnection(
      '0x111',
      new FakePrivacyOperations(),
      new FakePrivacyOperations(),
    );
    const destroyError = new Error('destroy failed');
    connected.port.destroy = () => { throw destroyError; };
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);

    expect(() => session.destroy()).toThrow(destroyError);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'selection-required',
      selectedKey: null,
      account: null,
    });
    await expect(session.operations.capability()).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(() => session.destroy()).not.toThrow();
  });

  it('preserves falsey explicit cleanup errors', async () => {
    const selected = wallet('Ready');
    const connected = controllableConnection(
      '0x111',
      new FakePrivacyOperations(),
      new FakePrivacyOperations(),
    );
    connected.port.subscribe = () => () => { throw null; };
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);

    let caught: unknown = Symbol('not caught');
    try {
      await session.disconnect();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(null);
    expect(session.getSnapshot()).toMatchObject({ phase: 'selection-required', account: null });
  });

  it('lets only the newest connection attempt publish financial authority', async () => {
    const first = wallet('First wallet');
    const second = wallet('Second wallet');
    let releaseFirst!: (connection: WalletConnectionPort) => void;
    const firstResult = new Promise<WalletConnectionPort>((resolve) => {
      releaseFirst = resolve;
    });
    const stale = connection('0x111');
    const staleDestroy = vi.spyOn(stale, 'destroy');
    const current = connection('0x222');
    const session = createWalletSession(denyAllOptions(), {
      discovery: discoveryWith(first, second),
      connectWallet: (selected) => selected === first ? firstResult : Promise.resolve(current),
    });
    const [firstChoice, secondChoice] = session.getSnapshot().wallets;

    const pendingFirst = session.connect(firstChoice!.key);
    await session.connect(secondChoice!.key);
    releaseFirst(stale);
    await pendingFirst;

    expect(staleDestroy).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'connected',
      selectedKey: secondChoice!.key,
      account: '0x222',
    });
  });

  it('requires an explicit discovered-wallet choice before connecting', async () => {
    const first = wallet('First wallet');
    const second = wallet('Second wallet');
    const discovery = discoveryWith(first, second);
    const firstConnection = connection('0x111');
    const secondConnection = connection('0x222');
    const connectWallet = vi.fn(async (selected: WalletHandle) =>
      selected === first ? firstConnection : secondConnection,
    );
    const session = createWalletSession(
      denyAllOptions(),
      { discovery, connectWallet },
    );

    const before = session.getSnapshot();
    expect(before.phase).toBe('selection-required');
    expect(before.wallets.map(({ name }) => name)).toEqual(['First wallet', 'Second wallet']);
    expect(connectWallet).not.toHaveBeenCalled();

    await session.connect(before.wallets[1]!.key);

    expect(connectWallet).toHaveBeenCalledTimes(1);
    expect(connectWallet).toHaveBeenCalledWith(second);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'connected',
      selectedKey: before.wallets[1]!.key,
      account: '0x222',
    });
    await expect(session.operations.capability()).resolves.toMatchObject({ supportsStrk20: true });
  });

  it('does not deliver an in-flight snapshot to a listener added during publish', () => {
    const selected = wallet('Ready');
    const discovery = controllableDiscovery(selected);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discovery.port, connectWallet: async () => connection('0x111') },
    );
    const late = vi.fn();
    let added = false;
    session.subscribe(() => {
      if (added) return;
      added = true;
      session.subscribe(late);
    });

    discovery.replace(selected);

    expect(late).not.toHaveBeenCalled();
    discovery.replace(selected);
    expect(late).toHaveBeenCalledOnce();
  });

  it('does not replay the current snapshot when a listener subscribes', () => {
    const selected = wallet('Ready');
    const discovery = controllableDiscovery(selected);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discovery.port, connectWallet: async () => connection('0x111') },
    );
    const listener = vi.fn();

    session.subscribe(listener);

    expect(listener).not.toHaveBeenCalled();
    discovery.replace(selected);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps reentrant publish synchronous with the latest authoritative snapshot', () => {
    const firstWallet = wallet('First');
    const secondWallet = wallet('Second');
    const discovery = controllableDiscovery(firstWallet);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discovery.port, connectWallet: async () => connection('0x111') },
    );
    const seen: string[] = [];
    let reentered = false;
    session.subscribe(() => {
      seen.push(`first:${session.getSnapshot().wallets.length}`);
      if (reentered) return;
      reentered = true;
      discovery.replace(firstWallet, secondWallet);
    });
    session.subscribe(() => {
      seen.push(`second:${session.getSnapshot().wallets.length}`);
    });

    discovery.replace(firstWallet);

    expect(seen).toEqual(['first:1', 'first:2', 'second:2', 'second:2']);
  });

  it('does not deliver an in-flight snapshot to a replacement listener generation', () => {
    const selected = wallet('Ready');
    const discovery = controllableDiscovery(selected);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discovery.port, connectWallet: async () => connection('0x111') },
    );
    const second = vi.fn();
    let replaced = false;
    let stopSecond!: () => void;
    session.subscribe(() => {
      if (replaced) return;
      replaced = true;
      stopSecond();
      stopSecond = session.subscribe(second);
    });
    stopSecond = session.subscribe(second);

    discovery.replace(selected);

    expect(second).not.toHaveBeenCalled();
    discovery.replace(selected);
    expect(second).toHaveBeenCalledOnce();
  });

  it('does not deliver an in-flight snapshot after unsubscribe before its turn', () => {
    const selected = wallet('Ready');
    const discovery = controllableDiscovery(selected);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discovery.port, connectWallet: async () => connection('0x111') },
    );
    const second = vi.fn();
    let stopSecond!: () => void;
    session.subscribe(() => stopSecond());
    stopSecond = session.subscribe(second);

    discovery.replace(selected);

    expect(second).not.toHaveBeenCalled();
  });

  it('keeps a replacement subscription when stale cleanup settles later', () => {
    const selected = wallet('Ready');
    const discovery = controllableDiscovery(selected);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discovery.port, connectWallet: async () => connection('0x111') },
    );
    const listener = vi.fn();
    const staleStop = session.subscribe(listener);
    session.subscribe(listener);

    staleStop();
    staleStop();
    discovery.replace(selected);

    expect(listener).toHaveBeenCalledOnce();
  });

  it('isolates a throwing subscriber from the transition and later subscribers', () => {
    const selected = wallet('Ready');
    const discovery = controllableDiscovery(selected);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discovery.port, connectWallet: async () => connection('0x111') },
    );
    const error = new Error('subscriber failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const later = vi.fn();
    session.subscribe(() => {
      throw error;
    });
    session.subscribe(later);

    try {
      expect(() => discovery.replace(selected)).not.toThrow();
      expect(later).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith('wallet session: subscriber threw', error);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('retires prepared work before a changed account can sign it', async () => {
    const selected = wallet('Ready');
    const oldConfirm = vi.fn(async () => ({ transactionHash: '0xold' }));
    const oldDiscard = vi.fn();
    const oldBatch = batch(oldConfirm, oldDiscard);
    const oldOperations = operationsWithBatch(oldBatch, '0.10.3');
    const newOperations = operationsWithBatch(batch(), '0.10.4');
    const connected = controllableConnection('0x111', oldOperations, newOperations);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );

    await session.connect(session.getSnapshot().wallets[0]!.key);
    const prepared = await session.operations.prepare([]);

    connected.changeAccount('0x222');

    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', account: '0x222' });
    await expect(prepared.confirm({ feeCeiling: 0n })).rejects.toMatchObject({
      kind: 'user-rejected',
    });
    expect(oldDiscard).toHaveBeenCalledTimes(1);
    expect(oldConfirm).not.toHaveBeenCalled();
    await expect(session.operations.capability()).resolves.toMatchObject({ walletApiVersion: '0.10.4' });
  });

  it('retires an old batch when confirmation succeeds after the account changes', async () => {
    const selected = wallet('Ready');
    let release!: (result: { transactionHash: string }) => void;
    const pending = new Promise<{ transactionHash: string }>((resolve) => { release = resolve; });
    const oldConfirm = vi.fn(() => pending);
    const oldDiscard = vi.fn();
    const connected = controllableConnection(
      '0x111',
      operationsWithBatch(batch(oldConfirm, oldDiscard), '0.10.3'),
      operationsWithBatch(batch(), '0.10.4'),
    );
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);
    const prepared = await session.operations.prepare([]);

    const confirming = prepared.confirm({ feeCeiling: 0n });
    connected.changeAccount('0x222');
    release({ transactionHash: '0xold' });

    await expect(confirming).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(oldDiscard).toHaveBeenCalledTimes(1);
  });

  it('retires an old batch when confirmation fails after the account changes', async () => {
    const selected = wallet('Ready');
    let reject!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
    const oldConfirm = vi.fn(() => pending);
    const oldDiscard = vi.fn(() => { throw new Error('cleanup failed'); });
    const connected = controllableConnection(
      '0x111',
      operationsWithBatch(batch(oldConfirm, oldDiscard), '0.10.3'),
      operationsWithBatch(batch(), '0.10.4'),
    );
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);
    const prepared = await session.operations.prepare([]);

    const confirming = prepared.confirm({ feeCeiling: 0n });
    connected.changeAccount('0x222');
    reject(new PrivacyError('unreachable', 'old account failure'));

    await expect(confirming).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(oldDiscard).toHaveBeenCalledTimes(1);
  });

  it('preserves submission uncertainty after the account changes', async () => {
    const selected = wallet('Ready');
    let reject!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
    const oldConfirm = vi.fn(() => pending);
    const oldDiscard = vi.fn(() => { throw new Error('cleanup failed'); });
    const uncertain = new PrivacyError('submission-uncertain', 'receipt status is unknown');
    const connected = controllableConnection(
      '0x111',
      operationsWithBatch(batch(oldConfirm, oldDiscard), '0.10.3'),
      operationsWithBatch(batch(), '0.10.4'),
    );
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);
    const prepared = await session.operations.prepare([]);

    const confirming = prepared.confirm({ feeCeiling: 0n });
    connected.changeAccount('0x222');
    reject(uncertain);

    await expect(confirming).rejects.toBe(uncertain);
    expect(oldDiscard).toHaveBeenCalledTimes(1);
  });

  it('keeps reviewed work owned across a duplicate account notification', async () => {
    const selected = wallet('Ready');
    const confirm = vi.fn(async () => ({ transactionHash: '0x1' }));
    const discard = vi.fn();
    const connected = controllableConnection(
      '0x111',
      operationsWithBatch(batch(confirm, discard), '0.10.3'),
      operationsWithBatch(batch(), '0.10.4'),
    );
    const createOperations = vi.spyOn(connected.port, 'createOperations');
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);
    const prepared = await session.operations.prepare([]);
    const generation = session.getSnapshot().generation;

    connected.changeAccount('0x0111');

    expect(session.getSnapshot()).toMatchObject({
      phase: 'connected',
      account: '0x111',
      generation,
    });
    expect(createOperations).toHaveBeenCalledOnce();
    await expect(prepared.confirm({ feeCeiling: 0n })).resolves.toEqual({ transactionHash: '0x1' });
    expect(confirm).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
  });

  it('fails closed when a connection notification cannot be read', async () => {
    const selected = wallet('Ready');
    const discard = vi.fn();
    const connected = controllableConnection(
      '0x111',
      operationsWithBatch(batch(undefined, discard), '0.10.3'),
      operationsWithBatch(batch(), '0.10.4'),
    );
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);
    const prepared = await session.operations.prepare([]);

    expect(() => connected.failSnapshot(new Error('wallet snapshot unavailable'))).not.toThrow();

    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', account: null });
    await expect(session.operations.capability()).rejects.toMatchObject({ kind: 'user-rejected' });
    await expect(prepared.confirm({ feeCeiling: 0n })).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(discard).toHaveBeenCalledOnce();
  });

  it('rejects a malformed account that is numerically equal to current authority', async () => {
    const selected = wallet('Ready');
    const confirm = vi.fn(async () => ({ transactionHash: '0x1' }));
    const discard = vi.fn();
    const connected = controllableConnection(
      '0x111',
      operationsWithBatch(batch(confirm, discard), '0.10.3'),
      operationsWithBatch(batch(), '0.10.4'),
    );
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);
    const prepared = await session.operations.prepare([]);

    connected.changeAccount('273');

    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', account: null });
    await expect(session.operations.capability()).rejects.toMatchObject({ kind: 'user-rejected' });
    await expect(prepared.confirm({ feeCeiling: 0n })).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(discard).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('discards a batch that finishes preparing after its account generation changed', async () => {
    const selected = wallet('Ready');
    let release!: (prepared: PreparedBatch) => void;
    const pendingBatch = new Promise<PreparedBatch>((resolve) => {
      release = resolve;
    });
    const discard = vi.fn();
    const oldOperations: PrivacyOperations = {
      ...operationsWithBatch(batch(), '0.10.3'),
      prepare: () => pendingBatch,
    };
    const connected = controllableConnection(
      '0x111',
      oldOperations,
      operationsWithBatch(batch(), '0.10.4'),
    );
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);

    const preparing = session.operations.prepare([]);
    connected.changeAccount('0x222');
    release(batch(undefined, discard));

    await expect(preparing).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('preserves the changed-session error when stale batch cleanup throws', async () => {
    const selected = wallet('Ready');
    let release!: (prepared: PreparedBatch) => void;
    const pendingBatch = new Promise<PreparedBatch>((resolve) => {
      release = resolve;
    });
    const discard = vi.fn(() => { throw new Error('cleanup failed'); });
    const oldOperations: PrivacyOperations = {
      ...operationsWithBatch(batch(), '0.10.3'),
      prepare: () => pendingBatch,
    };
    const connected = controllableConnection(
      '0x111',
      oldOperations,
      operationsWithBatch(batch(), '0.10.4'),
    );
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);

    const preparing = session.operations.prepare([]);
    connected.changeAccount('0x222');
    release(batch(undefined, discard));

    await expect(preparing).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('does not surface an old account error after a replacement owns the session', async () => {
    const selected = wallet('Ready');
    let rejectCapability!: (error: unknown) => void;
    const pendingCapability = new Promise<never>((_resolve, reject) => {
      rejectCapability = reject;
    });
    const oldOperations: PrivacyOperations = {
      ...operationsWithBatch(batch(), '0.10.3'),
      capability: () => pendingCapability,
    };
    const connected = controllableConnection(
      '0x111',
      oldOperations,
      operationsWithBatch(batch(), '0.10.4'),
    );
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);

    const detecting = session.operations.capability();
    connected.changeAccount('0x222');
    rejectCapability({ code: 162, message: 'old wallet unsupported' });

    await expect(detecting).rejects.toMatchObject({ kind: 'user-rejected' });
    await expect(session.operations.capability()).resolves.toMatchObject({ walletApiVersion: '0.10.4' });
  });

  it('disconnects the selected provider and invalidates its prepared work', async () => {
    const selected = wallet('Ready');
    const discard = vi.fn();
    const confirm = vi.fn(async () => ({ transactionHash: '0x1' }));
    const connected = controllableConnection(
      '0x111',
      operationsWithBatch(batch(confirm, discard), '0.10.3'),
      new FakePrivacyOperations(),
    );
    const disconnect = vi.spyOn(connected.port, 'disconnect');
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);
    const prepared = await session.operations.prepare([]);

    await session.disconnect();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'selection-required',
      selectedKey: null,
      account: null,
    });
    await expect(prepared.confirm({ feeCeiling: 0n })).rejects.toMatchObject({
      kind: 'user-rejected',
    });
    expect(discard).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('connects the selected Wallet Standard provider through WalletAccountV6', async () => {
    let emitChange!: (change: { features?: object }) => void;
    const standardConnect = vi.fn(async () => ({
      accounts: [{
        address: '0x123',
        publicKey: new Uint8Array(),
        chains: ['starknet:0x534e5f4d41494e'],
        features: [],
      }],
    }));
    const request = vi.fn(async ({ type }: { type: string }) => {
      if (type === 'wallet_requestChainId') return '0x534e5f4d41494e';
      if (type === 'wallet_supportedWalletApi') return ['0.10.3'];
      throw new Error(`Unexpected wallet request: ${type}`);
    });
    const wallet = {
      version: '1.0.0',
      name: 'Ready',
      icon: 'data:image/svg+xml,ready' as const,
      chains: ['starknet:0x534e5f4d41494e'],
      accounts: [],
      features: {
        'standard:connect': { version: '1.0.0', connect: standardConnect },
        'standard:disconnect': { version: '1.0.0', disconnect: vi.fn(async () => undefined) },
        'standard:events': {
          version: '1.0.0',
          on: vi.fn((_event: string, listener: (change: { features?: object }) => void) => {
            emitChange = listener;
            return () => undefined;
          }),
        },
        'starknet:walletApi': { version: '1.0.0', walletVersion: '5.33.8', id: 'ready', request },
      },
    };
    const session = createProductionWalletSession(denyAllOptions(), discoveryWith(wallet));

    await session.connect(session.getSnapshot().wallets[0]!.key);

    expect(standardConnect).toHaveBeenCalledWith({ silent: false });
    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', account: '0x123' });
    await expect(session.operations.capability()).resolves.toEqual({
      supportsStrk20: true,
      walletApiVersion: '0.10.3',
      registration: 'unknown',
    });

    const generation = session.getSnapshot().generation;
    emitChange({ features: wallet.features });

    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', account: '0x123' });
    expect(session.getSnapshot().generation).toBe(generation);
    await expect(session.operations.capability()).resolves.toMatchObject({ supportsStrk20: true });
    expect(request.mock.calls.map(([input]) => input.type)).toContain('wallet_supportedWalletApi');
  });

  it('captures an account change that arrives while the initial chain read is pending', async () => {
    let releaseChain!: (chainId: string) => void;
    let markChainRequested!: () => void;
    const chainRequested = new Promise<void>((resolve) => {
      markChainRequested = resolve;
    });
    const chainResult = new Promise<string>((resolve) => {
      releaseChain = resolve;
    });
    const eventListeners = new Set<(change: { accounts?: Array<{ address: string; chains: string[] }> }) => void>();
    const request = vi.fn(({ type }: { type: string }) => {
      if (type === 'wallet_requestChainId') {
        markChainRequested();
        return chainResult;
      }
      if (type === 'wallet_supportedWalletApi') return Promise.resolve(['0.10.3']);
      return Promise.reject(new Error(`Unexpected wallet request: ${type}`));
    });
    const wallet = {
      version: '1.0.0',
      name: 'Ready',
      icon: 'data:image/svg+xml,ready' as const,
      chains: ['starknet:0x534e5f4d41494e'],
      accounts: [],
      features: {
        'standard:connect': {
          version: '1.0.0',
          connect: vi.fn(async () => ({
            accounts: [{
              address: '0x111',
              publicKey: new Uint8Array(),
              chains: ['starknet:0x534e5f4d41494e'],
              features: [],
            }],
          })),
        },
        'standard:disconnect': { version: '1.0.0', disconnect: vi.fn(async () => undefined) },
        'standard:events': {
          version: '1.0.0',
          on: vi.fn((_event: string, listener: (change: { accounts?: Array<{ address: string; chains: string[] }> }) => void) => {
            eventListeners.add(listener);
            return () => eventListeners.delete(listener);
          }),
        },
        'starknet:walletApi': { version: '1.0.0', walletVersion: '5.33.8', id: 'ready', request },
      },
    };
    const session = createProductionWalletSession(denyAllOptions(), discoveryWith(wallet));

    const connecting = session.connect(session.getSnapshot().wallets[0]!.key);
    await chainRequested;
    eventListeners.forEach((listener) => listener({
      accounts: [{ address: '0x222', chains: ['starknet:0x534e5f4d41494e'] }],
    }));
    releaseChain('0x534e5f4d41494e');
    await connecting;

    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', account: '0x222' });
  });

  it('keeps a synchronous account replacement during subscribe as the session authority', async () => {
    const selected = wallet('Ready');
    const state = {
      account: '0x111',
      chainId: '0x534e5f4d41494e',
      operations: operationsWithBatch(batch(), '0.10.3'),
    };
    const replacement = operationsWithBatch(batch(), '0.10.4');
    const cleanup = vi.fn();
    const connected = synchronouslyChangingConnection(state, () => {
      state.account = '0x222';
      state.operations = replacement;
    }, undefined, cleanup);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected },
    );

    await session.connect(session.getSnapshot().wallets[0]!.key);

    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', account: '0x222' });
    await expect(session.operations.capability()).resolves.toMatchObject({ walletApiVersion: '0.10.4' });
    await session.disconnect();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not reconnect a synchronously disconnected wallet after subscribe', async () => {
    const selected = wallet('Ready');
    const state = {
      account: '0x111',
      chainId: '0x534e5f4d41494e',
      operations: new FakePrivacyOperations(),
    };
    const connected = synchronouslyChangingConnection(state, () => {
      state.account = '';
    });
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected },
    );

    await session.connect(session.getSnapshot().wallets[0]!.key);

    expect(session.getSnapshot()).toMatchObject({
      phase: 'selection-required',
      selectedKey: null,
      account: null,
    });
    await expect(session.operations.capability()).rejects.toMatchObject({ kind: 'user-rejected' });
  });

  it('does not destroy a synchronously retired connection twice', async () => {
    const selected = wallet('Ready');
    const state = {
      account: '0x111',
      chainId: '0x534e5f4d41494e',
      operations: new FakePrivacyOperations(),
    };
    const destroy = vi.fn(() => {
      if (destroy.mock.calls.length > 1) throw new Error('connection destroyed twice');
    });
    const connected = synchronouslyChangingConnection(state, () => {
      state.account = '';
    }, destroy);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected },
    );

    await expect(session.connect(session.getSnapshot().wallets[0]!.key)).resolves.toMatchObject({
      phase: 'selection-required',
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('does not retain cleanup for a connection retired during subscribe', async () => {
    const selected = wallet('Ready');
    const state = {
      account: '0x111',
      chainId: '0x534e5f4d41494e',
      operations: new FakePrivacyOperations(),
    };
    const cleanup = vi.fn(() => { throw new Error('stale cleanup'); });
    const connected = synchronouslyChangingConnection(state, () => {
      state.account = '';
    }, undefined, cleanup);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected },
    );

    await expect(session.connect(session.getSnapshot().wallets[0]!.key)).resolves.toMatchObject({
      phase: 'selection-required',
    });
    await expect(session.disconnect()).resolves.toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('keeps a wrong-network connection observable until it returns to mainnet', async () => {
    const selected = wallet('Ready');
    const connected = controllableConnection(
      '0x111',
      new FakePrivacyOperations(),
      new FakePrivacyOperations(),
      '0x534e5f5345504f4c4941',
    );
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );

    await session.connect(session.getSnapshot().wallets[0]!.key);
    expect(session.getSnapshot()).toMatchObject({ phase: 'wrong-network', account: null });

    connected.changeChain('0x534e5f4d41494e');

    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', account: '0x111' });
    await expect(session.operations.capability()).resolves.toMatchObject({ supportsStrk20: true });
  });

  it('retires the financial session when the wallet removes its account', async () => {
    const selected = wallet('Ready');
    const connected = controllableConnection(
      '0x111',
      new FakePrivacyOperations(),
      new FakePrivacyOperations(),
    );
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);

    connected.changeAccount('');

    expect(session.getSnapshot()).toMatchObject({
      phase: 'selection-required',
      selectedKey: null,
      account: null,
    });
    await expect(session.operations.capability()).rejects.toMatchObject({ kind: 'user-rejected' });
  });

  it('fails closed when replacement-account operations cannot be constructed', async () => {
    const selected = wallet('Ready');
    const connected = controllableConnection(
      '0x111',
      new FakePrivacyOperations(),
      new FakePrivacyOperations(),
    );
    const recoveredOperations = operationsWithBatch(batch(), '0.10.5');
    const createOperations = vi.fn()
      .mockReturnValueOnce(new FakePrivacyOperations())
      .mockImplementationOnce(() => {
        throw new Error('adapter construction failed');
      })
      .mockReturnValue(recoveredOperations);
    connected.port.createOperations = createOperations;
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discoveryWith(selected), connectWallet: async () => connected.port },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);

    expect(() => connected.changeAccount('0x222')).not.toThrow();
    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', account: null });
    await expect(session.operations.capability()).rejects.toMatchObject({ kind: 'user-rejected' });

    connected.notify();

    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', account: '0x222' });
    await expect(session.operations.capability()).resolves.toMatchObject({ walletApiVersion: '0.10.5' });
    expect(createOperations).toHaveBeenCalledTimes(3);
  });

  it('retires the financial session when the selected wallet disappears', async () => {
    const selected = wallet('Ready');
    const discovery = controllableDiscovery(selected);
    const session = createWalletSession(
      denyAllOptions(),
      { discovery: discovery.port, connectWallet: async () => connection('0x111') },
    );
    await session.connect(session.getSnapshot().wallets[0]!.key);

    discovery.replace();

    expect(session.getSnapshot()).toMatchObject({
      phase: 'selection-required',
      selectedKey: null,
      account: null,
      wallets: [],
    });
    await expect(session.operations.capability()).rejects.toMatchObject({ kind: 'user-rejected' });
  });

  it('owns a caller-mutable route policy before constructing wallet operations', async () => {
    const selected = wallet('Ready');
    const policy = {
      maxIntents: 0,
      maxRelayFee: 0n,
      enabledRoutes: [] as ('transfer')[],
      allowedTokens: { shield: [] as string[], unshield: [] as string[], transfer: [] as string[], swap: [] as string[] },
    };
    let receivedPolicy: unknown;
    const port = connection('0x111');
    port.createOperations = (owned) => {
      receivedPolicy = owned;
      return new FakePrivacyOperations();
    };
    const session = createWalletSession(
      { ...denyAllOptions(), policy },
      { discovery: discoveryWith(selected), connectWallet: async () => port },
    );

    policy.maxIntents = 1;
    policy.maxRelayFee = 1n;
    policy.enabledRoutes.push('transfer');
    policy.allowedTokens.transfer.push('0x1');
    await session.connect(session.getSnapshot().wallets[0]!.key);

    expect(receivedPolicy).toEqual({
      maxIntents: 0,
      maxRelayFee: 0n,
      enabledRoutes: [],
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
    });
    expect(Object.isFrozen(receivedPolicy)).toBe(true);
  });

  it('rejects an account outside the Stark field before publishing operations', async () => {
    const selected = wallet('Ready');
    const starkPrime = (1n << 251n) + 17n * (1n << 192n) + 1n;
    const session = createWalletSession(
      denyAllOptions(),
      {
        discovery: discoveryWith(selected),
        connectWallet: async () => connection(`0x${starkPrime.toString(16)}`),
      },
    );

    await expect(session.connect(session.getSnapshot().wallets[0]!.key)).rejects.toMatchObject({
      kind: 'unknown',
    });
    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', account: null });
    await expect(session.operations.capability()).rejects.toMatchObject({ kind: 'user-rejected' });
  });
});

function wallet(name: string): WalletHandle {
  return { name, icon: `data:image/svg+xml,${name}` };
}

function discoveryWith(...wallets: WalletHandle[]): WalletDiscoveryPort {
  return {
    getWallets: () => wallets,
    subscribe: () => () => undefined,
    refresh: () => undefined,
  };
}

function controllableDiscovery(...initialWallets: WalletHandle[]) {
  let wallets = initialWallets;
  const listeners = new Set<(wallets: readonly WalletHandle[]) => void>();
  const port: WalletDiscoveryPort = {
    getWallets: () => wallets,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: () => undefined,
  };
  return {
    port,
    replace(...next: WalletHandle[]) {
      wallets = next;
      listeners.forEach((listener) => listener(wallets));
    },
  };
}

function connection(account: string): WalletConnectionPort {
  const operations: PrivacyOperations = new FakePrivacyOperations();
  return {
    getSnapshot: () => ({ account, chainId: '0x534e5f4d41494e' }),
    createOperations: () => operations,
    subscribe: () => () => undefined,
    disconnect: async () => undefined,
    destroy: () => undefined,
  };
}

function controllableConnection(
  initialAccount: string,
  initialOperations: PrivacyOperations,
  replacementOperations: PrivacyOperations,
  initialChainId = '0x534e5f4d41494e',
) {
  let account = initialAccount;
  let chainId = initialChainId;
  let operations = initialOperations;
  let snapshotError: unknown = null;
  const listeners = new Set<() => void>();
  const port: WalletConnectionPort = {
    getSnapshot: () => {
      if (snapshotError) throw snapshotError;
      return { account, chainId };
    },
    createOperations: () => operations,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    disconnect: async () => undefined,
    destroy: () => listeners.clear(),
  };
  return {
    port,
    notify() {
      listeners.forEach((listener) => listener());
    },
    failSnapshot(error: unknown) {
      snapshotError = error;
      listeners.forEach((listener) => listener());
    },
    changeAccount(next: string) {
      account = next;
      operations = replacementOperations;
      listeners.forEach((listener) => listener());
    },
    changeChain(next: string) {
      chainId = next;
      listeners.forEach((listener) => listener());
    },
  };
}

function synchronouslyChangingConnection(
  state: { account: string; chainId: string; operations: PrivacyOperations },
  onSubscribe: () => void,
  destroy: () => void = () => undefined,
  cleanup: () => void = () => undefined,
): WalletConnectionPort {
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({ account: state.account, chainId: state.chainId }),
    createOperations: () => state.operations,
    subscribe(listener) {
      listeners.add(listener);
      onSubscribe();
      listener();
      return () => {
        cleanup();
        listeners.delete(listener);
      };
    },
    disconnect: async () => undefined,
    destroy,
  };
}

function operationsWithBatch(prepared: PreparedBatch, walletApiVersion: string): PrivacyOperations {
  return {
    capability: async () => ({ supportsStrk20: true, walletApiVersion, registration: 'unknown' }),
    poolConfig: async () => ({ feeAmount: 0n, feeToken: '0x1', proofValidityBlocks: 1, noteMaturityBlocks: 1 }),
    balances: async () => [],
    recipientStatus: async () => 'registered',
    prepare: async () => prepared,
  };
}

function batch(
  confirm = vi.fn(async () => ({ transactionHash: '0x1' })),
  discard = vi.fn(),
): PreparedBatch {
  return {
    intents: [],
    poolFee: 0n,
    gasEstimate: 0n,
    totalCost: 0n,
    warnings: [],
    promptCount: 0,
    confirm,
    discard,
  };
}

function denyAllOptions() {
  return {
    rpcUrl: 'https://rpc.example',
    backendBaseUrl: '/api',
    expectedChainId: '0x534e5f4d41494e',
    policy: {
      maxIntents: 0,
      maxRelayFee: 0n,
      enabledRoutes: [],
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
    },
  } as const;
}
