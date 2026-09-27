import { useEffect } from 'react';
import type { BuildingId } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { useArrivalNudge } from '../bridge/ArrivalNudgeProvider.js';
import { usePrivacy } from '../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { useStore } from '../store/use-store.js';
import type { BankFlow } from './bank/bank-machine.js';
import { nextStepAfterIntents } from './next-step.js';

/** Counter states calm enough for a reminder. Never the commit point. */
const REMINDER_FLOWS: ReadonlySet<BankFlow['name']> = new Set(['idle', 'loading-pool', 'composing']);

/**
 * The one journey notice at the top of a Bank-machine window (the Bank, its
 * shielding station, the Post Office and the Bridge's shield step).
 *
 * On the receipt screen it suggests the next step for what settled. At a calm
 * counter in the Bank it carries the D-021 Bridge nudge. At the commit point
 * it shows nothing, for the same reason the window withdraws its header
 * disclosure there: only the batch's own disclosures belong on screen.
 */
export function BankJourneyNotice({
  building,
  flow,
  register = PRIVACY_REGISTER,
  bridgeNudge = true,
}: {
  building: BuildingId;
  flow: BankFlow;
  register?: readonly RouteGrade[];
  /**
   * Whether this window may carry the Bridge arrival nudge. It says "shield it
   * here", so a Bank window with no shield control (the staking station) sets
   * this false.
   */
  bridgeNudge?: boolean;
}) {
  const arrival = useArrivalNudge();
  const refresh = arrival?.refresh;
  useEffect(() => {
    // Opening the counter is a moment the saved Bridge record may have moved.
    refresh?.();
  }, [refresh]);

  if (flow.name === 'submitted') {
    return <ReceiptNextStep building={building} transactionHash={flow.transactionHash} register={register} />;
  }
  if (building !== 'bank' || !bridgeNudge || !REMINDER_FLOWS.has(flow.name) || !arrival?.waiting) return null;
  return (
    <div className="journey-next journey-arrival" role="note">
      <p>{COPY.next.bridgeArrivalHere}</p>
      <button type="button" aria-label={COPY.next.dismissLabel} onClick={arrival.dismiss}>
        {COPY.next.dismiss}
      </button>
    </div>
  );
}

/**
 * The next step for a receipt, read from the ledger rather than the window.
 *
 * The ledger already records what settled (`Receipt.intents`), so a window
 * reopened on a receipt that landed while it was shut gets the same prompt.
 */
export function ReceiptNextStep({
  building,
  transactionHash,
  register = PRIVACY_REGISTER,
}: {
  building: BuildingId;
  transactionHash: string | null;
  register?: readonly RouteGrade[];
}) {
  const { receipts } = usePrivacy();
  const held = useStore(receipts.store);
  if (transactionHash === null) return null;
  const receipt = held.find(
    (entry) => entry.building === building && entry.transactionHash === transactionHash,
  );
  const text = receipt ? nextStepAfterIntents(receipt.intents, register) : null;
  return text ? (
    <p className="journey-next" role="status">
      {text}
    </p>
  ) : null;
}
