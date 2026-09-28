#!/usr/bin/env bash
# Prints the privacy level of every route, and what still needs approval.
#
# The default is absolute privacy. Anything less is a deviation that needs the
# project lead's explicit approval AND plain-language disclosure to the player.
# Run this before shipping any integration.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

npx --yes tsx@4 -e '
import { PRIVACY_REGISTER, isDisclosureWaived, isRoutePlayable, isDeviation, routesAwaitingApproval, routesAwaitingCopy } from "./packages/shared/src/privacy-grades.ts";

const LABEL: Record<string, string> = {
  private:       "PRIVATE      parties and amounts hidden, no public leg",
  anonymous:     "ANONYMOUS    who acted is hidden, but PART OF THE ACTION IS VISIBLE (see below)",
  "public-edge": "PUBLIC EDGE  actor and amount visible on-chain",
  public:        "PUBLIC       no privacy claim",
};

console.log("\nSTRKWORLD — privacy levels by route\n");
console.log("Default is absolute privacy. Anything below needs approval AND disclosure.\n");

for (const r of PRIVACY_REGISTER) {
  const dev = isDeviation(r.grade);
  const mark = !dev ? "  " : isRoutePlayable(r) ? "OK" : "!!";
  console.log(`${mark} ${r.route}`);
  console.log(`     ${LABEL[r.grade]}`);
  console.log(`     observer sees: ${r.observable}`);
  if (r.disclosure) console.log(`     player is told: "${r.disclosure}"`);
  if (dev) {
    if (!r.approvedBy)      console.log("     ⚠ AWAITING APPROVAL — decision for the project lead");
    else if (!r.disclosure && isDisclosureWaived(r))
                            console.log(`     approved by ${r.approvedBy} on ${r.approvedOn} — in-game disclosure WAIVED by ${r.disclosureWaivedBy}; the player is told nothing about this grade`);
    else if (!r.disclosure) console.log(`     ⚠ approved by ${r.approvedBy} on ${r.approvedOn} — AWAITING PLAYER-FACING COPY`);
    else                    console.log(`     approved by ${r.approvedBy} on ${r.approvedOn}`);
    if (r.rationale) console.log(`     rationale: ${r.rationale}`);
  }
  if (r.returnToPool) console.log("     → funnels the player back into the pool afterwards (D-021)");
  console.log();
}

const noApproval = routesAwaitingApproval();
const noCopy = routesAwaitingCopy();

if (noApproval.length) {
  console.log(`${noApproval.length} route(s) awaiting APPROVAL — a decision, not a task:`);
  for (const r of noApproval) console.log(`  - ${r.route} (${r.grade})`);
  console.log("  Set approvedBy, approvedOn and rationale in packages/shared/src/privacy-grades.ts\n");
}
if (noCopy.length) {
  console.log(`${noCopy.length} approved route(s) awaiting PLAYER-FACING COPY:`);
  for (const r of noCopy) console.log(`  - ${r.route} (${r.grade})`);
  console.log("  Write the disclosure string in the same file. Until then the door stays locked —");
  console.log("  an approved deviation the player is never told about is still a silent downgrade.\n");
}
const waived = PRIVACY_REGISTER.filter((r) => isDeviation(r.grade) && isDisclosureWaived(r));
if (!noApproval.length && !noCopy.length) {
  console.log(waived.length
    ? `Every deviation is approved; all are disclosed except ${waived.length} waived by decision: ${waived.map((r) => `${r.route} (${r.disclosureWaivedBy})`).join(", ")}.\n`
    : "Every deviation is approved and disclosed.\n");
}
' 2>&1
