import { describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, PrivacyError } from '@strkworld/privacy';
import { createConnectFlow, toWalletStatus } from './connect-machine.js';

describe('connect flow', () => {
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

  it('routes an unregistered account to its own room', async () => {
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

  it('escalates a 118 from a later operation into the not-registered room', async () => {
    const flow = createConnectFlow(new FakePrivacyOperations());
    await flow.connect();

    flow.noteOperationError(new PrivacyError('not-registered', 'error 118'));
    expect(flow.store.getState().name).toBe('not-registered');
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

  it('recheck moves a registered player out of the 118 room', async () => {
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

  it('passes detecting through to the world as connecting', () => {
    expect(toWalletStatus({ name: 'detecting' })).toBe('connecting');
  });
});
