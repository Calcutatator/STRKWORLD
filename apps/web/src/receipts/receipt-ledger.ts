import type { Intent } from '@strkworld/privacy';
import type { BuildingId } from '@strkworld/shared';
import { createStore, type ReadableStore } from '../store/store.js';

/**
 * Receipts, held outside the panel that produced them.
 *
 * A submitted transaction settles whether or not the room is still on screen,
 * and the panel's lifecycle is **not** under the player's control: the world
 * emits `building:exited` and `VisitLayer` unmounts the window. Keeping the hash
 * in panel state therefore loses it — the transaction settles, the player is
 * told nothing, and the only proof they have is gone.
 *
 * So the ledger lives above the panels, in the provider. A panel records into
 * it the instant the seam returns, before it checks whether it is still the
 * current attempt, and reads any outstanding receipt when it reopens.
 *
 * **Lifetime is the whole point.** Anything constructing a panel has to supply
 * one, which is why it is a required option rather than a defaulted one — a
 * ledger created per panel would compile, pass, and quietly restore the bug.
 *
 * *Not persisted.* A receipt does not survive a page reload, which is a real
 * gap: a player who reloads mid-signing still loses the hash. Fixing it means
 * writing a transaction hash to browser storage, and that is a privacy decision
 * with a correlation surface — it belongs in `docs/DECISIONS.md`, not in a
 * convenience commit. See the findings log.
 */

export interface Receipt {
  readonly building: BuildingId;
  readonly transactionHash: string;
  /** What settled. Kept so the receipt can describe itself, not just its hash. */
  readonly intents: readonly Intent[];
}

export interface ReceiptLedger {
  /** Subscribe to see receipts arrive while no panel is open. */
  readonly store: ReadableStore<readonly Receipt[]>;
  record(receipt: Receipt): void;
  /** Unacknowledged receipts for a building, oldest first. */
  pending(building: BuildingId): readonly Receipt[];
  acknowledge(transactionHash: string): void;
}

export function createReceiptLedger(): ReceiptLedger {
  const ownerStore = createStore<readonly Receipt[]>(Object.freeze([]));
  const store: ReadableStore<readonly Receipt[]> = Object.freeze({
    getState: ownerStore.getState,
    getServerSnapshot: ownerStore.getServerSnapshot,
    subscribe: ownerStore.subscribe,
  });

  return Object.freeze({
    store,

    record(receipt: Receipt): void {
      // Idempotent on hash: a retry that resolves twice must not produce two
      // receipts for one transaction.
      const identity = receiptIdentity(receipt.transactionHash);
      if (ownerStore.getState().some((held) => receiptIdentity(held.transactionHash) === identity)) return;
      const snapshot: Receipt = Object.freeze({
        building: receipt.building,
        transactionHash: receipt.transactionHash,
        intents: Object.freeze(receipt.intents.map((intent): Intent => Object.freeze({ ...intent }))),
      });
      ownerStore.setState((held) => Object.freeze([...held, snapshot]));
    },

    pending(building: BuildingId): readonly Receipt[] {
      return Object.freeze(ownerStore.getState().filter((receipt) => receipt.building === building));
    },

    acknowledge(transactionHash: string): void {
      const identity = receiptIdentity(transactionHash);
      ownerStore.setState((held) => Object.freeze(
        held.filter((receipt) => receiptIdentity(receipt.transactionHash) !== identity),
      ));
    },
  });
}

function receiptIdentity(transactionHash: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(transactionHash)) return `raw:${transactionHash}`;
  const value = BigInt(transactionHash);
  const starkFieldPrime = (1n << 251n) + (17n << 192n) + 1n;
  return value === 0n || value >= starkFieldPrime
    ? `raw:${transactionHash}`
    : `felt:${value.toString(16)}`;
}
