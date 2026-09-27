import { ENDUR_DEPOSIT_ANONYMIZER, ENDUR_XSTRK, ENDUR_XSTRK_ASSET } from './endur.js';
import type {
  PreparedArtifact,
  PrivateRoute,
  RelayFee,
  SwapAuthorizationBinding,
} from './types.js';
import { ApiFailure, sameAddress } from './validation.js';

const U128_LIMIT = 1n << 128n;

type ServerAction =
  | { kind: 'transfer-from'; from: string; token: string; amount: bigint }
  | { kind: 'transfer-to'; to: string; token: string; amount: bigint }
  | { kind: 'invoke'; contract: string; calldata: string[] }
  | { kind: 'invoke-with-computation'; contract: string; calldata: string[] }
  | { kind: 'viewing-key-event'; variant: 4 }
  | { kind: 'deposit-event'; variant: 6 }
  | { kind: 'other'; variant: number };

/**
 * Decode the pool's Cairo `Span<ServerAction>` enough to enforce route policy.
 * Layout is pinned to the audited privacy ABI; unknown variants fail closed.
 */
export function decodeServerActions(calldata: readonly string[]): ServerAction[] {
  const cursor = new Cursor(calldata);
  const length = cursor.number('server action count');
  if (length > 128) throw new ApiFailure(400, 'Too many server actions.');
  const actions: ServerAction[] = [];
  for (let index = 0; index < length; index += 1) {
    const variant = cursor.number('server action variant');
    switch (variant) {
      case 0: // WriteOnce(storage_address, Span<felt>)
        cursor.felt(); cursor.span(); actions.push({ kind: 'other', variant }); break;
      case 1: // Append(recipient, EncChannelInfo[3])
        cursor.take(4); actions.push({ kind: 'other', variant }); break;
      case 2: { // TransferFrom(from, token, amount)
        const [from, token, amount] = cursor.take(3);
        actions.push({ kind: 'transfer-from', from: from!, token: token!, amount: BigInt(amount!) });
        break;
      }
      case 3: { // TransferTo(to, token, amount)
        const [to, token, amount] = cursor.take(3);
        actions.push({ kind: 'transfer-to', to: to!, token: token!, amount: BigInt(amount!) });
        break;
      }
      case 4: // EmitViewingKeySet(user, public_key, EncPrivateKey[3])
        cursor.take(5); actions.push({ kind: 'viewing-key-event', variant }); break;
      case 5: // EmitWithdrawal(EncUserAddr[3], to, token, amount)
        cursor.take(6); actions.push({ kind: 'other', variant }); break;
      case 6: // EmitDeposit(user, token, amount)
        cursor.take(3); actions.push({ kind: 'deposit-event', variant }); break;
      case 7: // EmitOpenNoteCreated(EncUserAddr[3], token, note_id)
        cursor.take(5); actions.push({ kind: 'other', variant }); break;
      case 8: // EmitEncNoteCreated(note_id, packed_value)
        cursor.take(2); actions.push({ kind: 'other', variant }); break;
      case 9: // EmitNoteUsed(nullifier)
        cursor.take(1); actions.push({ kind: 'other', variant }); break;
      case 10: { // Invoke(contract, Span<felt>)
        const contract = cursor.felt();
        actions.push({ kind: 'invoke', contract, calldata: cursor.span() });
        break;
      }
      case 11: { // InvokeWithComputation(contract, Span<felt>)
        const contract = cursor.felt();
        actions.push({ kind: 'invoke-with-computation', contract, calldata: cursor.span() });
        break;
      }
      default: throw new ApiFailure(400, 'Unknown privacy-pool server action.');
    }
  }
  cursor.done();
  return actions;
}

export function validateServerActionRoute(
  route: PrivateRoute,
  artifact: PreparedArtifact,
  fee: RelayFee,
  operationToken: string,
  swap?: SwapAuthorizationBinding,
): void {
  const calldata = artifact.call.calldata ?? [];
  const output = artifact.proof.output;
  const serializedActions = output.slice(1);
  if (
    serializedActions.length > calldata.length ||
    serializedActions.some((felt, index) => !sameAddress(felt, calldata[index]!))
  ) {
    throw new ApiFailure(400, 'Proof output does not bind the submitted pool call.');
  }
  const screening = validateScreeningSuffix(calldata.slice(serializedActions.length));

  const actions = decodeServerActions(serializedActions);
  if (actions.some((action) =>
    action.kind === 'transfer-from' ||
    action.kind === 'deposit-event' ||
    action.kind === 'viewing-key-event' ||
    action.kind === 'invoke-with-computation'
  )) {
    throw new ApiFailure(400, 'Private route contains an unauthorized public or computed action.');
  }
  if (screening === 'some') {
    throw new ApiFailure(400, 'Private route cannot carry a public-deposit screening attestation.');
  }
  const invokes = actions.filter((action) => action.kind === 'invoke');
  const transfers = actions.filter(
    (action): action is Extract<ServerAction, { kind: 'transfer-to' }> => action.kind === 'transfer-to',
  );
  const isFeeTransfer = (action: Extract<ServerAction, { kind: 'transfer-to' }>) =>
    sameAddress(action.to, fee.recipient) &&
    sameAddress(action.token, fee.token) &&
    action.amount === fee.amount;
  if (route === 'transfer') {
    if (invokes.length > 0) throw new ApiFailure(400, 'Transfer route cannot invoke an external contract.');
    if (transfers.length !== 1 || !isFeeTransfer(transfers[0]!)) {
      throw new ApiFailure(400, 'Transfer route does not contain exactly the authorized relay fee.');
    }
  } else if (route === 'unshield') {
    if (invokes.length > 0) throw new ApiFailure(400, 'Unshield route cannot invoke an external contract.');
    const feeIndex = transfers.findIndex(isFeeTransfer);
    const withdrawalIndex = transfers.findIndex((action, index) =>
      index !== feeIndex &&
      sameAddress(action.token, operationToken),
    );
    if (transfers.length !== 2 || feeIndex < 0 || withdrawalIndex < 0) {
      throw new ApiFailure(400, 'Unshield route contains an unauthorized withdrawal.');
    }
  } else if (route === 'stake') {
    validateStakeActions(invokes, transfers, isFeeTransfer, operationToken);
  } else {
    if (!swap) throw new ApiFailure(401, 'Swap authorization has no quote binding.');
    if (invokes.length !== 1) {
      throw new ApiFailure(400, 'Swap route must contain exactly one private executor call.');
    }
    const invoke = invokes[0]!;
    if (!sameAddress(invoke.contract, swap.executor)) {
      throw new ApiFailure(400, 'Swap executor does not match the authorized AVNU plan.');
    }
    if (
      invoke.calldata.length !== swap.invokePrefix.length + 1 ||
      swap.invokePrefix.some((felt, index) => !sameAddress(felt, invoke.calldata[index]!))
    ) {
      throw new ApiFailure(400, 'Swap calldata does not match the authorized AVNU plan.');
    }
    if (transfers.length !== 2) {
      throw new ApiFailure(400, 'Swap withdrawals do not match the authorized AVNU plan.');
    }
    const feeIndex = transfers.findIndex(isFeeTransfer);
    const sellIndex = transfers.findIndex((action, index) =>
      index !== feeIndex &&
      sameAddress(action.to, swap.executor) &&
      sameAddress(action.token, swap.sellToken) &&
      action.amount === swap.sellAmount,
    );
    if (feeIndex < 0 || sellIndex < 0) {
      throw new ApiFailure(400, 'Swap withdrawals do not match the authorized AVNU plan.');
    }
  }
}

/**
 * Endur staking (D-063). The one external invoke must be the pinned anonymizer
 * with `privacy_invoke(in_token, out_token, assets: u256, note_id)` calldata:
 * STRK — the authorized operation token — in, xSTRK out, a nonzero u256, and
 * the wallet-resolved note id, which is left unchecked as the swap leaves its
 * own. The only withdrawals allowed are the authorized relay fee and exactly
 * `assets` of STRK to the anonymizer, so the authorization cannot sponsor any
 * other call or move any other value.
 */
function validateStakeActions(
  invokes: readonly Extract<ServerAction, { kind: 'invoke' }>[],
  transfers: readonly Extract<ServerAction, { kind: 'transfer-to' }>[],
  isFeeTransfer: (action: Extract<ServerAction, { kind: 'transfer-to' }>) => boolean,
  operationToken: string,
): void {
  if (invokes.length !== 1) {
    throw new ApiFailure(400, 'Stake route must contain exactly one Endur anonymizer call.');
  }
  const invoke = invokes[0]!;
  if (!sameAddress(invoke.contract, ENDUR_DEPOSIT_ANONYMIZER)) {
    throw new ApiFailure(400, 'Stake invoke target is not the Endur deposit anonymizer.');
  }
  if (invoke.calldata.length !== 5) {
    throw new ApiFailure(400, 'Stake calldata does not match the Endur anonymizer signature.');
  }
  const [inToken, outToken, low, high] = invoke.calldata as [string, string, string, string, string];
  if (
    !sameAddress(inToken, operationToken) ||
    !sameAddress(inToken, ENDUR_XSTRK_ASSET) ||
    !sameAddress(outToken, ENDUR_XSTRK)
  ) {
    throw new ApiFailure(400, 'Stake tokens do not match the authorized route.');
  }
  const assets = u256FromLimbs(low, high);
  if (transfers.length !== 2) {
    throw new ApiFailure(400, 'Stake withdrawals do not match the authorized route.');
  }
  const feeIndex = transfers.findIndex(isFeeTransfer);
  const stakeIndex = transfers.findIndex((action, index) =>
    index !== feeIndex &&
    sameAddress(action.to, ENDUR_DEPOSIT_ANONYMIZER) &&
    sameAddress(action.token, operationToken) &&
    action.amount === assets,
  );
  if (feeIndex < 0 || stakeIndex < 0) {
    throw new ApiFailure(400, 'Stake withdrawals do not match the authorized route.');
  }
}

/** A Cairo u256 is (low, high), each limb a u128. Zero stakes nothing. */
function u256FromLimbs(low: string, high: string): bigint {
  const lowValue = BigInt(low);
  const highValue = BigInt(high);
  const value = lowValue + (highValue << 128n);
  if (lowValue >= U128_LIMIT || highValue >= U128_LIMIT || value === 0n) {
    throw new ApiFailure(400, 'Stake amount is not a valid nonzero u256.');
  }
  return value;
}

function validateScreeningSuffix(suffix: readonly string[]): 'compatibility' | 'none' | 'some' {
  if (suffix.length === 0) return 'compatibility';
  const variant = BigInt(suffix[0]!);
  const isNone = variant === 1n && suffix.length === 1;
  const isSome = variant === 0n && suffix.length === 4 && BigInt(suffix[1]!) <= (1n << 64n) - 1n;
  if (!isNone && !isSome) {
    throw new ApiFailure(400, 'Pool screening attestation calldata is malformed.');
  }
  return isNone ? 'none' : 'some';
}

class Cursor {
  private offset = 0;

  constructor(private readonly values: readonly string[]) {}

  felt(): string {
    const value = this.values[this.offset++];
    if (value === undefined) throw new ApiFailure(400, 'Truncated server-action calldata.');
    return value;
  }

  number(label: string): number {
    const value = BigInt(this.felt());
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ApiFailure(400, `Invalid ${label}.`);
    }
    return Number(value);
  }

  take(count: number): string[] {
    if (count > this.values.length - this.offset) {
      throw new ApiFailure(400, 'Truncated server-action calldata.');
    }
    const values = this.values.slice(this.offset, this.offset + count);
    this.offset += count;
    return values;
  }

  span(): string[] {
    return this.take(this.number('span length'));
  }

  done(): void {
    if (this.offset !== this.values.length) {
      throw new ApiFailure(400, 'Trailing server-action calldata is not allowed.');
    }
  }
}
