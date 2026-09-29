import type { EventBus, ShellEvents, WalletStatus } from '@strkworld/shared';
import { createStore, type ReadableStore } from '../store/store.js';

/**
 * The HUD's view of the Shell's own presentation events.
 *
 * `hud:balance`, `hud:pending` and `wallet:status` were published for a
 * World-drawn HUD that was never built (ARCHITECTURE, "Reading a balance").
 * This is their consumer, and it is a listener and nothing else: it never
 * emits, never asks the wallet for anything and holds no money — only the
 * pre-formatted string the Bank chose to publish after the player asked for a
 * read. Balance reads stay manual because every one of them prompts the wallet.
 *
 * Payloads are owned and validated like World events
 * (`bus/world-event-payload.ts`). The bus is shared with the World, so a
 * malformed payload leaves the last good value on screen instead of reaching it.
 */

export interface HudState {
  /** Null until the first `wallet:status`. */
  readonly wallet: WalletStatus | null;
  /** The Bank's pre-formatted display string. Null while unknown. */
  readonly balance: string | null;
  /** Financial handoffs in flight across every mounted window. */
  readonly pending: number;
}

export type HudEvent =
  | { readonly name: 'wallet:status'; readonly payload: unknown }
  | { readonly name: 'hud:balance'; readonly payload: unknown }
  | { readonly name: 'hud:pending'; readonly payload: unknown };

export interface HudModel {
  readonly store: ReadableStore<HudState>;
  /**
   * Subscribe to the Shell bus. The returned cleanup owns every subscription.
   *
   * `currentWallet` is read once, after subscribing: the bus does not replay
   * (D-038), so a HUD that subscribes after the last `wallet:status` (behind
   * D-072's entry gate) would otherwise show "Checking wallet…" until the
   * status next changed. Later events win as usual.
   */
  listen(bus: EventBus<ShellEvents>, currentWallet?: () => WalletStatus | null): () => void;
}

const WALLET_STATUSES: ReadonlySet<unknown> = new Set<WalletStatus>([
  'disconnected',
  'connecting',
  'connected',
  'unsupported',
  'unregistered',
]);

/** Long enough for any `formatStrk` output; a longer string is not a balance. */
const MAX_DISPLAY_LENGTH = 96;
const MAX_PENDING = 10_000;
/** Control characters have no place in a one-line HUD figure. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const EMPTY_HUD: HudState = Object.freeze({ wallet: null, balance: null, pending: 0 });

function ownData(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** `undefined` means the payload is not one the HUD will render. */
export function ownBalanceDisplay(payload: unknown): string | null | undefined {
  const display = ownData(payload, 'display');
  if (display === null) return null;
  if (typeof display !== 'string') return undefined;
  const trimmed = display.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function ownPendingCount(payload: unknown): number | undefined {
  const count = ownData(payload, 'count');
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= MAX_PENDING
    ? count
    : undefined;
}

export function ownWalletStatus(payload: unknown): WalletStatus | undefined {
  const status = ownData(payload, 'status');
  return WALLET_STATUSES.has(status) ? (status as WalletStatus) : undefined;
}

/**
 * One event applied to the HUD. Pure; returns `state` itself when nothing
 * changes, so the store does not notify.
 *
 * A balance belongs to a connected account. Any other wallet status makes it
 * unknown, and a figure arriving while the wallet is known to be elsewhere is
 * ignored rather than shown against the wrong state.
 */
export function applyHudEvent(state: HudState, event: HudEvent): HudState {
  switch (event.name) {
    case 'wallet:status': {
      const wallet = ownWalletStatus(event.payload);
      if (wallet === undefined) return state;
      const balance = wallet === 'connected' ? state.balance : null;
      if (wallet === state.wallet && balance === state.balance) return state;
      return Object.freeze({ ...state, wallet, balance });
    }
    case 'hud:balance': {
      const balance = ownBalanceDisplay(event.payload);
      if (balance === undefined || balance === state.balance) return state;
      if (balance !== null && state.wallet !== null && state.wallet !== 'connected') return state;
      return Object.freeze({ ...state, balance });
    }
    case 'hud:pending': {
      const pending = ownPendingCount(event.payload);
      if (pending === undefined || pending === state.pending) return state;
      return Object.freeze({ ...state, pending });
    }
  }
}

export function createHudModel(initial: HudState = EMPTY_HUD): HudModel {
  const owner = createStore<HudState>(Object.freeze({ ...initial }));
  const store: ReadableStore<HudState> = Object.freeze({
    getState: owner.getState,
    getServerSnapshot: owner.getServerSnapshot,
    subscribe: owner.subscribe,
  });
  const apply = (event: HudEvent): void => owner.setState((previous) => applyHudEvent(previous, event));

  return Object.freeze({
    store,
    listen(bus: EventBus<ShellEvents>, currentWallet?: () => WalletStatus | null): () => void {
      const stops = [
        bus.on('wallet:status', (payload) => apply({ name: 'wallet:status', payload })),
        bus.on('hud:balance', (payload) => apply({ name: 'hud:balance', payload })),
        bus.on('hud:pending', (payload) => apply({ name: 'hud:pending', payload })),
      ];
      let status: WalletStatus | null = null;
      try {
        status = currentWallet?.() ?? null;
      } catch {
        // A snapshot that cannot be read leaves the next event to say.
      }
      // Validated like any bus payload: an unknown value changes nothing.
      if (status !== null) apply({ name: 'wallet:status', payload: { status } });
      return () => {
        for (const stop of stops.splice(0)) stop();
      };
    },
  });
}
