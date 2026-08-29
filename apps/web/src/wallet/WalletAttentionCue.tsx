import { resolveAvatarSheet } from '@strkworld/world';
import type { OperationStage } from '@strkworld/privacy';
import { useEffect, useRef } from 'react';
import { COPY } from '../copy.js';

export type WalletAttentionKind = 'connect' | 'balance' | 'confirm';

const TITLES: Readonly<Record<WalletAttentionKind, string>> = Object.freeze({
  connect: COPY.walletAttention.connectTitle,
  balance: COPY.walletAttention.balanceTitle,
  confirm: COPY.walletAttention.confirmTitle,
});

const AVATAR = resolveAvatarSheet('avatar-1');

export function walletOperationAttention(
  balanceLoading: boolean,
  stage: OperationStage | null,
): WalletAttentionKind | null {
  if (balanceLoading) return 'balance';
  return stage === 'awaiting-approval' ? 'confirm' : null;
}

/**
 * One conspicuous but data-free handoff for a real-wallet step (D-058).
 *
 * `signal` is injectable so lifecycle tests can prove one signal per owned
 * handoff without constructing a browser audio device.
 */
export function WalletAttentionCue({
  active,
  kind,
  signal = signalWalletAttention,
}: {
  active: boolean;
  kind: WalletAttentionKind;
  signal?: () => void;
}) {
  const signalOwner = useRef(signal);
  signalOwner.current = signal;

  useEffect(() => {
    if (!active || typeof document === 'undefined') return;

    const previousTitle = document.title;
    document.title = COPY.walletAttention.tabTitle;
    // Deferral collapses React StrictMode's setup/cleanup probe into the live
    // owner and avoids sounding twice for one handoff.
    const timer = globalThis.setTimeout(() => signalOwner.current(), 0);

    return () => {
      globalThis.clearTimeout(timer);
      if (document.title === COPY.walletAttention.tabTitle) {
        document.title = previousTitle;
      }
    };
  }, [active, kind]);

  if (!active) return null;

  return (
    <aside
      className="wallet-attention-cue"
      data-wallet-attention={kind}
      role="alert"
      aria-live="assertive"
    >
      <span className="wallet-attention-avatar" aria-hidden="true">
        <img
          className="wallet-attention-avatar-sheet"
          src={AVATAR.url}
          width={AVATAR.width}
          height={AVATAR.height}
          alt=""
          draggable={false}
        />
      </span>
      <span className="wallet-attention-copy">
        <strong>{TITLES[kind]}</strong>
        <span>{COPY.walletAttention.body}</span>
      </span>
    </aside>
  );
}

/** Best-effort local signal; it never asks for notification permission. */
export function signalWalletAttention(): void {
  try {
    if (typeof navigator !== 'undefined') {
      navigator.vibrate?.([90, 50, 90]);
    }
  } catch {
    // Device-policy failures do not own the visual handoff.
  }
  if (typeof AudioContext === 'undefined') return;

  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime;

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(740, start);
    oscillator.frequency.exponentialRampToValueAtTime(1_110, start + 0.16);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.addEventListener('ended', () => closeAudioContext(context), { once: true });
    oscillator.start(start);
    oscillator.stop(start + 0.21);
    if (context.state === 'suspended') {
      void context.resume().catch(() => closeAudioContext(context));
    }
  } catch {
    // The fixed visual and tab marker remain authoritative when audio is
    // unavailable or blocked by the browser/device.
    closeAudioContext(context);
  }
}

function closeAudioContext(context: AudioContext | null): void {
  if (!context) return;
  try {
    void context.close().catch(() => undefined);
  } catch {
    // Some implementations can fail synchronously as well as by rejection.
  }
}
