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
 */
export function unsupportedCopy(walletName: string | null): { title: string; body: string } {
  const name = walletName?.trim() || null;
  const fill = (template: string): string =>
    template.replace(/\{(Wallet|wallet)\}/g, (_token, slot: string) =>
      name ?? (slot === 'Wallet' ? COPY.unsupported.unnamed : COPY.unsupported.unnamedInline));
  return { title: fill(COPY.unsupported.title), body: fill(COPY.unsupported.body) };
}
