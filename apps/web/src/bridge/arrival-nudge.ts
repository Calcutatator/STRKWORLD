import type { BridgeRecord } from '@strkworld/bridge';
// The one deep path into `@strkworld/bridge`. Its index re-exports the 1Click
// client and SDK, which stay out of the eager graph on purpose
// (`architecture.test.ts`); `persistence.ts` has no runtime imports at all, so
// the entry chunk gains the record reader and nothing else.
import { LocalBridgeStore } from '@strkworld/bridge/src/persistence.js';
import { sameAddress } from '../format.js';
import { createStore, type ReadableStore } from '../store/store.js';
import type { ViewerStorage } from '../store/viewer-storage.js';

/**
 * The persistent Bridge → Bank nudge (D-021), read from the Bridge's own record.
 *
 * D-021 requires the prompt to persist: a player who bridges and closes the
 * tab still holds public STRK, and must find the nudge waiting rather than
 * discover months later that their funds never went in. The Bridge already
 * keeps exactly the evidence that needs — its signed, browser-local
 * `BridgeRecord` (D-043) — so this reads that record and records nothing about
 * the Bridge of its own.
 *
 * Lifecycle, decided from D-021 and D-043:
 *
 * - **Appears** while the saved record has settled with a positive
 *   `strkReceived` (STRK landed publicly) and, when a wallet session binds an
 *   account, that account is the record's signed recipient. D-043 blocks every
 *   shield continuation for a different account, so the nudge does too.
 * - **Ends** when the record is gone: the player discarded it at the Bridge
 *   (D-043 keeps it until they explicitly do) or replaced it with a new deposit.
 * - **Or** when the player dismisses *that* arrival. The dismissal is keyed by
 *   an opaque fingerprint of the record, so a later arrival nudges again, and
 *   it is deleted as soon as the record it names no longer exists — discarding
 *   the Bridge record leaves no trace behind here.
 * - **Never** because a shield happened. D-043: STRKWORLD persists no
 *   Bridge-to-shield correlation, and a shield of some amount does not prove
 *   the bridged STRK went in. The nudge cannot know, so it does not guess: the
 *   player tells it, by discarding the record or dismissing the reminder.
 *
 * Read-only. `LocalBridgeStore` owns the storage key and the validation, and
 * the adapter below swallows its writes, so an invalid record is never cleared
 * from here — that remains the Bridge's decision. The read is structural only
 * (the signature check lives in `BridgeService`, which is not loaded eagerly);
 * that is enough for a reminder, which authorises nothing. The shield it
 * points at is an ordinary Bank action the player reviews and signs.
 *
 * Local only: no provider request, no wallet prompt, nothing on the bus and
 * nothing in lobby traffic.
 */

export const ARRIVAL_DISMISSED_KEY = 'strkworld.hud.bridge-arrival-dismissed.v1';

export interface SettledArrival {
  /** Opaque fingerprint of one saved record. Identity, not secrecy. */
  readonly id: string;
  readonly recipient: string;
}

export interface ArrivalNudgeState {
  /** A settled arrival waits for this account and the player has not dismissed it. */
  readonly waiting: boolean;
}

export interface ArrivalNudge {
  readonly store: ReadableStore<ArrivalNudgeState>;
  /** Re-read the saved record. Cheap and local; safe on any hint of change. */
  refresh(): void;
  /** Hide the reminder for the arrival saved now, and for nothing after it. */
  dismiss(): void;
}

export interface ArrivalNudgeOptions {
  readonly storage: ViewerStorage;
  /**
   * The connected account when a wallet session binds one, `null` while it
   * binds none (which fails closed), or `undefined` when the composition has
   * no wallet session at all — the local demo's single fixed account.
   */
  readonly account?: () => string | null | undefined;
}

const WAITING: ArrivalNudgeState = Object.freeze({ waiting: true });
const NOT_WAITING: ArrivalNudgeState = Object.freeze({ waiting: false });

/** The saved record's settled arrival, or null. Never writes, never throws. */
export function readSettledArrival(storage: ViewerStorage): SettledArrival | null {
  let record: BridgeRecord | null;
  try {
    record = new LocalBridgeStore({
      getItem: (key) => storage.read(key),
      setItem: () => {},
      removeItem: () => {},
    }).load();
  } catch {
    return null;
  }
  if (!record) return null;
  const { status } = record;
  if (status.leg !== 'settled' || typeof status.strkReceived !== 'bigint' || status.strkReceived <= 0n) {
    return null;
  }
  return Object.freeze({ id: arrivalId(record), recipient: record.starknetRecipient });
}

export function createArrivalNudge({
  storage,
  account = () => undefined,
}: ArrivalNudgeOptions): ArrivalNudge {
  const owner = createStore<ArrivalNudgeState>(NOT_WAITING);
  const store: ReadableStore<ArrivalNudgeState> = Object.freeze({
    getState: owner.getState,
    getServerSnapshot: owner.getServerSnapshot,
    subscribe: owner.subscribe,
  });
  // Only for a browser that refuses the write: the dismissal then lasts as
  // long as this page, and the nudge is back on the next visit.
  let dismissedHere: string | null = null;

  const publish = (waiting: boolean): void => owner.setState(waiting ? WAITING : NOT_WAITING);

  const boundTo = (arrival: SettledArrival): boolean => {
    let current: string | null | undefined;
    try {
      current = account();
    } catch {
      return false;
    }
    if (current === undefined) return true;
    return current !== null && sameAddress(arrival.recipient, current);
  };

  function refresh(): void {
    const arrival = readSettledArrival(storage);
    const saved = storage.read(ARRIVAL_DISMISSED_KEY);
    // A dismissal outlives nothing: once its record is gone, so is it.
    if (saved !== null && saved !== arrival?.id) storage.remove(ARRIVAL_DISMISSED_KEY);
    if (dismissedHere !== null && dismissedHere !== arrival?.id) dismissedHere = null;
    if (!arrival) {
      publish(false);
      return;
    }
    const dismissed = saved === arrival.id || dismissedHere === arrival.id;
    publish(!dismissed && boundTo(arrival));
  }

  function dismiss(): void {
    const arrival = readSettledArrival(storage);
    if (arrival) {
      dismissedHere = arrival.id;
      storage.write(ARRIVAL_DISMISSED_KEY, arrival.id);
    }
    publish(false);
  }

  return Object.freeze({ store, refresh, dismiss });
}

/**
 * One saved deposit, fingerprinted. A deposit address is unique to its signed
 * quote; the creation time separates a re-used address. Only the hash is ever
 * stored, so the dismissal key holds no address, amount or timestamp.
 */
function arrivalId(record: BridgeRecord): string {
  const quote = record.signedQuote.quote;
  return fnv1a32(
    ['bridge-arrival', quote.depositAddress ?? '', quote.depositMemo ?? '', String(record.createdAt)].join('\u0000'),
  );
}

/** FNV-1a over UTF-16 code units. Compared with one saved value, never a secret. */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
