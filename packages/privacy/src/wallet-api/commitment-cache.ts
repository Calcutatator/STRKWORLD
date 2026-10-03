import { PrivacyError } from '../types.js';
import { mapShadowWalletError } from './errors.js';
import type { WalletStrk20Account } from './types.js';

/**
 * The one place this package asks a wallet for a shadow-account partial
 * commitment, and the one place the answers are kept (D-122, amended
 * 2026-10-03).
 *
 * `wallet_strk20ShadowAccountCommitment(dapp_name)` may prompt the player, and
 * every route used to hold its own cache: the Vault's resolver, the Borrow
 * counter's, unstaking's, the swap's and the placement's. A placement check
 * asked for the season commitment and then, with DeFi ranking on, for all four
 * feature commitments, so one check could prompt five times. One cache per
 * wallet connection, shared by every route, makes any commitment at most one
 * prompt per connection — and a check that needs nothing new, none.
 *
 * **Memory only.** The answers live in this object's `Map` and nowhere else:
 * never in `localStorage` or `sessionStorage`, never in a log, an error
 * message, a callback or a result. The cache is dropped with the connection
 * and cleared explicitly on disconnect (D-120) and on an account change, so a
 * second account can never read the first one's commitments.
 *
 * Nothing here branches on wallet identity: the dapp name is the only key.
 */
export class WalletCommitmentCache {
  private readonly wallet: WalletStrk20Account;
  /** The answers given on this connection, by dapp name. Memory only. */
  private readonly answers = new Map<string, string>();
  /** Requests in flight, so two routes asking at once make one prompt. */
  private readonly asking = new Map<string, Promise<string>>();

  constructor(wallet: WalletStrk20Account) {
    this.wallet = wallet;
  }

  /**
   * The partial commitment for one dapp name: the cached answer, the request
   * already in flight, or one new wallet request (which may prompt). A refused
   * or invalid answer is not cached, so the next flow may ask again.
   *
   * `onAsked` reports only a request that actually reached the wallet, so a
   * cached answer and a joined request stay as silent as they are cheap.
   */
  commitment(dappName: string, onAsked?: (ok: boolean, error?: unknown) => void): Promise<string> {
    const cached = this.answers.get(dappName);
    if (cached !== undefined) return Promise.resolve(cached);
    const flight = this.asking.get(dappName);
    if (flight) return flight;
    const request = (async () => {
      let answer: unknown;
      try {
        if (!hasCommitmentMethod(this.wallet)) {
          throw new PrivacyError('shadow-accounts-unsupported', 'This wallet does not support STRK20 shadow accounts yet.');
        }
        answer = await this.wallet.strk20ShadowAccountCommitment!(dappName);
      } catch (error) {
        onAsked?.(false, error);
        throw mapShadowWalletError(error);
      }
      if (typeof answer !== 'string' || !isFelt(answer) || BigInt(answer) === 0n) {
        onAsked?.(false);
        throw new PrivacyError('unknown', 'The wallet returned an invalid shadow-account commitment.');
      }
      this.answers.set(dappName, answer);
      onAsked?.(true);
      return answer;
    })();
    this.asking.set(dappName, request);
    const forget = () => {
      if (this.asking.get(dappName) === request) this.asking.delete(dappName);
    };
    request.then(forget, forget);
    return request;
  }

  /**
   * The cached answer, or null. Never asks the wallet, so it can never prompt:
   * this is what a placement check reads for the feature shadows, so it sends
   * only the partials the player's own session already shared.
   */
  cached(dappName: string): string | null {
    return this.answers.get(dappName) ?? null;
  }

  /** Whether asking for this dapp name would reach the wallet (and so may prompt). */
  willAsk(dappName: string): boolean {
    return !this.answers.has(dappName);
  }

  /** Forget everything: the disconnect path (D-120) and an account change. */
  clear(): void {
    this.answers.clear();
    this.asking.clear();
  }
}

/**
 * Whether the account exposes `strk20ShadowAccountCommitment` as a method: an
 * own or inherited data property holding a function, as `WalletAccountV6`
 * declares it on its prototype. An accessor is refused without being run, and
 * a throwing trap reads as absent.
 */
export function hasCommitmentMethod(wallet: WalletStrk20Account): boolean {
  try {
    let current: object | null = wallet;
    for (let hops = 0; current !== null && hops < 16; hops += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'strk20ShadowAccountCommitment');
      if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function';
      current = Object.getPrototypeOf(current) as object | null;
    }
    return false;
  } catch {
    return false;
  }
}

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

export function isFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) < STARK_FIELD_PRIME;
}
