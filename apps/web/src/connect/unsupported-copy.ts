import type { WalletSessionSnapshot } from '@strkworld/privacy';
import { COPY } from '../copy.js';

/**
 * The connected wallet's name as the picker lists it, or null (D-073).
 *
 * Display only: it fills a sentence and is never compared, so nothing the app
 * does depends on which wallet this is (SPEC §5 rule 2). The choice is found
 * by the session's own opaque key, not by anything the wallet says about
 * itself.
 */
export function selectedWalletName(
  snapshot: Pick<WalletSessionSnapshot, 'wallets' | 'selectedKey'> | null | undefined,
): string | null {
  if (!snapshot || snapshot.selectedKey === null) return null;
  const label = snapshot.wallets.find((choice) => choice.key === snapshot.selectedKey)?.name.trim();
  return label ? label : null;
}

/**
 * The unsupported-wallet room's title and body, naming the wallet when the
 * shell knows its name and saying "Your wallet" when it does not. One pass
 * over the template, with a replacer function, so a name is inserted as it
 * stands: neither `$&` nor a placeholder inside it is expanded.
 *
 * Given `tooOld`, the body says the wallet's Wallet API is older than the
 * city needs and names both versions, instead of saying it has no STRK20
 * methods at all.
 */
export function unsupportedCopy(
  walletName: string | null,
  tooOld?: { reported: string; required: string },
): { title: string; body: string } {
  const name = walletName?.trim() || null;
  const fill = (template: string): string =>
    template.replace(/\{(Wallet|wallet|version|required)\}/g, (_token, slot: string) => {
      if (slot === 'version') return tooOld?.reported ?? '';
      if (slot === 'required') return tooOld?.required ?? '';
      return name ?? (slot === 'Wallet' ? COPY.unsupported.unnamed : COPY.unsupported.unnamedInline);
    });
  return {
    title: fill(COPY.unsupported.title),
    body: fill(tooOld ? COPY.unsupported.tooOld : COPY.unsupported.body),
  };
}

/**
 * The lowest Wallet API version that opens the city, as the room names it.
 * A copy of `@strkworld/privacy`'s `REQUIRED_WALLET_API_VERSION`, because a
 * value import of the seam would pull starknet.js into the entry chunk; a
 * test holds the two equal.
 */
export const REQUIRED_WALLET_API_LABEL = '0.10.3';

/**
 * The unsupported room's whole text for a connect state: its title, its
 * body, and the "Wallet API x.y.z" detail line, which a too-old body already
 * carries and so leaves out.
 */
export function unsupportedRoomCopy(
  walletName: string | null,
  state: { walletApiVersion: string | null; versionTooOld?: true },
): { title: string; body: string; detail: string | null } {
  const tooOld = state.versionTooOld === true && state.walletApiVersion !== null
    ? { reported: state.walletApiVersion, required: REQUIRED_WALLET_API_LABEL }
    : undefined;
  return {
    ...unsupportedCopy(walletName, tooOld),
    detail: !tooOld && state.walletApiVersion ? `Wallet API ${state.walletApiVersion}` : null,
  };
}
