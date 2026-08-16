import type {
  PreparedArtifact,
  PrivateRoute,
  RelayFee,
  SwapAuthorizationBinding,
} from './types.js';
import { ApiFailure, sameAddress } from './validation.js';

type ServerAction =
  | { kind: 'transfer-to'; to: string; token: string; amount: bigint }
  | { kind: 'invoke'; contract: string; calldata: string[] }
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
      case 2: // TransferFrom(from, token, amount)
        cursor.take(3); actions.push({ kind: 'other', variant }); break;
      case 3: { // TransferTo(to, token, amount)
        const [to, token, amount] = cursor.take(3);
        actions.push({ kind: 'transfer-to', to: to!, token: token!, amount: BigInt(amount!) });
        break;
      }
      case 4: // EmitViewingKeySet(user, public_key, EncPrivateKey[3])
        cursor.take(5); actions.push({ kind: 'other', variant }); break;
      case 5: // EmitWithdrawal(EncUserAddr[3], to, token, amount)
        cursor.take(6); actions.push({ kind: 'other', variant }); break;
      case 6: // EmitDeposit(user, token, amount)
        cursor.take(3); actions.push({ kind: 'other', variant }); break;
      case 7: // EmitOpenNoteCreated(EncUserAddr[3], depositor, token, note_id)
        cursor.take(6); actions.push({ kind: 'other', variant }); break;
      case 8: // EmitNoteUsed(nullifier)
        cursor.take(1); actions.push({ kind: 'other', variant }); break;
      case 9: { // Invoke(contract, Span<felt>)
        const contract = cursor.felt();
        actions.push({ kind: 'invoke', contract, calldata: cursor.span() });
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
  if (
    output.length !== calldata.length + 1 ||
    calldata.some((felt, index) => !sameAddress(felt, output[index + 1]!))
  ) {
    throw new ApiFailure(400, 'Proof output does not bind the submitted pool call.');
  }

  const actions = decodeServerActions(calldata);
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
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiFailure(400, `Invalid ${label}.`);
    return Number(value);
  }

  take(count: number): string[] {
    return Array.from({ length: count }, () => this.felt());
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
