import { isAddress } from 'viem';
import type { SourceChain } from './types.js';

export type AddressCheck = { ok: true } | { ok: false; hint: string };

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

/** Shape check only. The 1Click quote endpoint remains authoritative. */
export function validateSourceAddress(chain: SourceChain, raw: string): AddressCheck {
  if (typeof raw !== 'string') return { ok: false, hint: 'Enter an address.' };
  const address = raw.trim();
  if (!address) return { ok: false, hint: 'Enter an address.' };

  switch (chain) {
    case 'near':
      return address.length >= 2 && address.length <= 64 &&
        /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*)$/.test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid NEAR account ID.' };
    case 'ethereum':
    case 'base':
    case 'arbitrum':
    case 'polygon':
    case 'bsc':
    case 'abstract':
    case 'gnosis':
    case 'berachain':
    case 'monad':
    case 'xlayer':
    case 'plasma':
    case 'optimism':
    case 'avalanche':
    case 'adi':
    case 'scroll':
    case 'hypercore':
      return isAddress(address, { strict: true }) && BigInt(address) !== 0n
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid EVM address.' };
    case 'solana':
    case 'fogo':
      return new RegExp(`^${BASE58}{32,44}$`).test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid base58 account address.' };
    case 'sui':
    case 'movement':
    case 'aptos':
      return /^0x[0-9a-fA-F]{1,64}$/.test(address) && BigInt(address) !== 0n
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid Move-chain address.' };
    case 'bitcoin':
      return /^(?:bc1[ac-hj-np-z02-9]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/i.test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid Bitcoin address.' };
    case 'bitcoin-cash':
      return /^(?:bitcoincash:)?[qp][a-z0-9]{41,61}$/i.test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid Bitcoin Cash address.' };
    case 'litecoin':
      return /^(?:ltc1[ac-hj-np-z02-9]{11,71}|[LM3][1-9A-HJ-NP-Za-km-z]{25,34})$/i.test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid Litecoin address.' };
    case 'dogecoin':
      return /^[DA9][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid Dogecoin address.' };
    case 'dash':
      return /^[X7][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid Dash address.' };
    case 'zcash':
      return /^(?:u1[ac-hj-np-z02-9]{20,200}|zs1[ac-hj-np-z02-9]{20,100}|t[13][1-9A-HJ-NP-Za-km-z]{33})$/i.test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid Zcash address.' };
    case 'xrp':
      return new RegExp(`^r${BASE58}{24,34}$`).test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid XRP classic address.' };
    case 'cardano':
      return /^(?:addr|addr_test)1[ac-hj-np-z02-9]{20,120}$/i.test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid Cardano address.' };
    case 'aleo':
      return /^aleo1[ac-hj-np-z02-9]{50,70}$/i.test(address)
        ? { ok: true }
        : { ok: false, hint: 'Enter a valid Aleo address.' };
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
    default:
      return { ok: false, hint: 'Unsupported source chain.' };
  }
}

export function validateStarknetAddress(raw: string): AddressCheck {
  if (typeof raw !== 'string') return { ok: false, hint: 'Enter a Starknet felt address.' };
  const address = raw.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    return { ok: false, hint: 'Enter a Starknet felt address.' };
  }
  const value = BigInt(address);
  return value > 0n && value < STARK_FIELD_PRIME
    ? { ok: true }
    : { ok: false, hint: 'Enter a non-zero Starknet felt address.' };
}
