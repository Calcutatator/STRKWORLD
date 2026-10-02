#!/usr/bin/env bash
# Prints the privacy level of every route, and what still needs approval.
#
# The default is absolute privacy. Anything less is a deviation that needs the
# project lead's explicit approval. A route's pre-commit line, if any, is
# ordinary product copy (D-118).
# Run this before shipping any integration.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

npx --yes tsx@4 -e '
import { PRIVACY_REGISTER, isRoutePlayable, isDeviation, routesAwaitingApproval } from "./packages/shared/src/privacy-grades.ts";

const LABEL: Record<string, string> = {
  private:       "PRIVATE      parties and amounts hidden, no public leg",
  anonymous:     "ANONYMOUS    who acted is hidden, but PART OF THE ACTION IS VISIBLE (see below)",
  "public-edge": "PUBLIC EDGE  actor and amount visible on-chain",
  public:        "PUBLIC       no privacy claim",
};

console.log("\nSTRKWORLD — privacy levels by route\n");
console.log("Default is absolute privacy. Anything below needs approval.\n");

for (const r of PRIVACY_REGISTER) {
  const dev = isDeviation(r.grade);
  const mark = !dev ? "  " : isRoutePlayable(r) ? "OK" : "!!";
  console.log(`${mark} ${r.route}`);
  console.log(`     ${LABEL[r.grade]}`);
  console.log(`     observer sees: ${r.observable}`);
  if (r.disclosure) console.log(`     player is told: "${r.disclosure}"`);
  if (dev) {
    if (!r.approvedBy)      console.log("     ⚠ AWAITING APPROVAL — decision for the project lead");
    else                    console.log(`     approved by ${r.approvedBy} on ${r.approvedOn}`);
    if (r.rationale) console.log(`     rationale: ${r.rationale}`);
  }
  if (r.returnToPool) console.log("     → funnels the player back into the pool afterwards (D-021)");
  console.log();
}

const noApproval = routesAwaitingApproval();

if (noApproval.length) {
  console.log(`${noApproval.length} route(s) awaiting APPROVAL — a decision, not a task:`);
  for (const r of noApproval) console.log(`  - ${r.route} (${r.grade})`);
  console.log("  Set approvedBy, approvedOn and rationale in packages/shared/src/privacy-grades.ts\n");
}
if (!noApproval.length) console.log("Every deviation is approved.\n");
' 2>&1
