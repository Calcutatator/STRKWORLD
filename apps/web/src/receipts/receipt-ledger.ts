import type { Intent } from '@strkworld/privacy';
import type { BuildingId } from '@strkworld/shared';
import { createStore, type Store } from '../store/store.js';

/**
 * Receipts, held outside the panel that produced them.
 *
 * A submitted transaction settles whether or not the room is still on screen,
 * and the panel's lifecycle is **not** under the player's control: the world
 * emits `building:exited` and `PanelLayer` unmounts the panel. Keeping the hash
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
  building: BuildingId;
  transactionHash: string;
  /** What settled. Kept so the receipt can describe itself, not just its hash. */
  intents: readonly Intent[];
}

export interface ReceiptLedger {
  /** Subscribe to see receipts arrive while no panel is open. */
  readonly store: Store<readonly Receipt[]>;
  record(receipt: Receipt): void;
  /** Unacknowledged receipts for a building, oldest first. */
  pending(building: BuildingId): readonly Receipt[];
  acknowledge(transactionHash: string): void;
}

export function createReceiptLedger(): ReceiptLedger {
  const store = createStore<readonly Receipt[]>([]);

  return {
    store,

    record(receipt: Receipt): void {
      // Idempotent on hash: a retry that resolves twice must not produce two
      // receipts for one transaction.
      if (store.getState().some((held) => held.transactionHash === receipt.transactionHash)) return;
      store.setState((held) => [...held, receipt]);
    },

    pending(building: BuildingId): readonly Receipt[] {
      return store.getState().filter((receipt) => receipt.building === building);
    },

    acknowledge(transactionHash: string): void {
      store.setState((held) => held.filter((receipt) => receipt.transactionHash !== transactionHash));
    },
  };
}
