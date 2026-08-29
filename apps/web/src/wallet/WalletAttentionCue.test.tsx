// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '../copy.js';
import { WalletAttentionCue, walletOperationAttention } from './WalletAttentionCue.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('WalletAttentionCue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.title = 'STRKWORLD';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the approved mini avatar as an assertive fixed wallet handoff', () => {
    const markup = renderToStaticMarkup(
      <WalletAttentionCue active kind="balance" signal={() => {}} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('data-wallet-attention="balance"');
    expect(markup).toContain(COPY.walletAttention.balanceTitle);
    expect(markup).toContain(COPY.walletAttention.body);
    expect(markup).toMatch(/<img[^>]+avatar-1\.png/);
  });

  it('stays absent when no human-owned wallet step is active', () => {
    expect(renderToStaticMarkup(
      <WalletAttentionCue active={false} kind="confirm" signal={() => {}} />,
    )).toBe('');
  });

  it('maps only balance approval and the explicit wallet approval stage to attention', () => {
    expect(walletOperationAttention(true, null)).toBe('balance');
    expect(walletOperationAttention(false, 'awaiting-approval')).toBe('confirm');
    for (const stage of ['composing', 'proving', 'submitting', 'confirming', 'done', 'failed'] as const) {
      expect(walletOperationAttention(false, stage)).toBeNull();
    }
    expect(walletOperationAttention(false, null)).toBeNull();
  });

  it('signals once for one owned handoff, survives StrictMode, and restores the tab title', async () => {
    const signal = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <WalletAttentionCue active kind="connect" signal={signal} />
        </StrictMode>,
      );
    });
    expect(document.title).toBe(COPY.walletAttention.tabTitle);

    await act(async () => {
      vi.runAllTimers();
    });
    expect(signal).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(
        <StrictMode>
          <WalletAttentionCue active kind="connect" signal={signal} />
        </StrictMode>,
      );
      vi.runAllTimers();
    });
    expect(signal).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(
        <StrictMode>
          <WalletAttentionCue active={false} kind="connect" signal={signal} />
        </StrictMode>,
      );
    });
    expect(document.title).toBe('STRKWORLD');

    await act(async () => root.unmount());
    container.remove();
  });
});
