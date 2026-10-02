/**
 * Wallets known not to implement the STRK20 Wallet API (D-108).
 *
 * This is the one place STRKWORLD looks at a wallet's identity, and the only
 * thing it does with the answer is leave the wallet out of discovery, so it is
 * never listed in the picker. It never admits a wallet, never reaches the
 * STRK20 path, and never replaces the capability check: every wallet that is
 * listed still has to answer `wallet_supportedWalletApi` (SPEC §5 rule 2,
 * D-093). A wallet on this list that later ships the STRK20 methods comes off
 * it by deleting its entry.
 *
 * Entries:
 *
 * - **MetaMask, including its Starknet Snap.** get-starknet reaches it through
 *   EIP-6963 (`rdns` `io.metamask`, `io.metamask.flask`), a Wallet API id of
 *   `metamask`, or a legacy `window.starknet_metamask` global. The Snap has no
 *   `wallet_strk20*` methods. In the 2026-10-02 live test, connecting to it
 *   failed with 163 and raised MetaMask window after MetaMask window.
 *
 * A wallet matches when its name, its Wallet API id, its own `id` or its
 * `rdns`, lowercased with everything but letters and digits removed, contains
 * an entry's token. Every field is read guarded: a getter or trap that throws
 * leaves the field unread, and a wallet with no readable field never matches.
 */
export const UNSUPPORTED_WALLETS: readonly UnsupportedWallet[] = Object.freeze([
  Object.freeze({ label: 'MetaMask (including its Starknet Snap)', token: 'metamask' }),
]);

export interface UnsupportedWallet {
  /** Who this entry excludes, for people reading the code. Never shown. */
  readonly label: string;
  /** Lowercase letters and digits matched inside each normalised field. */
  readonly token: string;
}

const STARKNET_WALLET_API = 'starknet:walletApi';

/** True when a discovered wallet is on the denylist above. */
export function isUnsupportedWallet(wallet: unknown): boolean {
  if ((typeof wallet !== 'object' && typeof wallet !== 'function') || wallet === null) return false;
  return identityFields(wallet).some((field) => matchesUnsupportedIdentity(field));
}

/** True when one identity string (name, id or rdns) names a listed wallet. */
export function matchesUnsupportedIdentity(value: string): boolean {
  const normalised = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalised.length === 0) return false;
  return UNSUPPORTED_WALLETS.some(({ token }) => normalised.includes(token));
}

function identityFields(wallet: object): string[] {
  const fields: string[] = [];
  for (const key of ['name', 'id', 'rdns'] as const) {
    const value = guardedRead(wallet, key);
    if (typeof value === 'string') fields.push(value);
  }
  const features = guardedRead(wallet, 'features');
  if ((typeof features === 'object' || typeof features === 'function') && features !== null) {
    const walletApi = guardedRead(features, STARKNET_WALLET_API);
    if ((typeof walletApi === 'object' || typeof walletApi === 'function') && walletApi !== null) {
      const walletApiId = guardedRead(walletApi, 'id');
      if (typeof walletApiId === 'string') fields.push(walletApiId);
    }
  }
  return fields;
}

/**
 * An own data property as it stands, an own accessor refused unread, and
 * otherwise the inherited value (how Wallet Standard and get-starknet's own
 * wallet classes expose these fields, as class getters). Any throw yields
 * undefined.
 */
function guardedRead(value: object, key: string): unknown {
  try {
    const own = Object.getOwnPropertyDescriptor(value, key);
    if (own) return 'value' in own ? own.value : undefined;
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}
