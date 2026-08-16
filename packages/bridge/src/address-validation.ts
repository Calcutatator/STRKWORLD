import { isAddress } from 'viem';
import type { SourceChain } from './types.js';

export type AddressCheck = { ok: true } | { ok: false; hint: string };

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';

/** Shape check only. The 1Click quote endpoint remains authoritative. */
export function validateSourceAddress(chain: SourceChain, raw: string): AddressCheck {
  const address = raw.trim();
  if (!address) return { ok: false, hint: 'Enter an address.' };

  switch (chain) {
    case 'ethereum':
    case 'base':
    case 'arbitrum':
    case 'polygon':
    case 'bsc':
      return isAddress(address, { strict: true })
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid EVM address.' };
    case 'solana':
      return new RegExp(`^${BASE58}{32,44}$`).test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid Solana base58 address.' };
    case 'stellar':
      return /^G[A-Z2-7]{55}$/.test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a 56-character Stellar G-address.' };
    case 'ton':
      return /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_\-+/]{46}$/.test(address) ||
        /^-?[0-9]:[0-9a-fA-F]{64}$/.test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid TON address.' };
    case 'tron':
      return new RegExp(`^T${BASE58}{33}$`).test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a 34-character Tron T-address.' };
  }
}

export function validateStarknetAddress(raw: string): AddressCheck {
  return /^0x[0-9a-fA-F]{1,64}$/.test(raw.trim())
    ? { ok: true }
    : { ok: false, hint: 'Enter a Starknet felt address.' };
}
