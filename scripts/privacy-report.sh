#!/usr/bin/env bash
# Prints the privacy level of every route, and what still needs approval.
#
# The default is absolute privacy. Anything less is a deviation that needs the
# project lead's explicit approval AND plain-language disclosure to the player.
# Run this before shipping any integration.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

npx --yes tsx@4 -e '
import { PRIVACY_REGISTER, isRoutePlayable, isDeviation } from "./packages/shared/src/privacy-grades.ts";

const LABEL: Record<string, string> = {
  private:       "PRIVATE      parties and amounts hidden, no public leg",
  anonymous:     "ANONYMOUS    parties hidden, AMOUNTS VISIBLE",
  "public-edge": "PUBLIC EDGE  actor and amount visible on-chain",
  public:        "PUBLIC       no privacy claim",
};

console.log("\nSTRKWORLD — privacy levels by route\n");
console.log("Default is absolute privacy. Anything below needs your approval.\n");

for (const r of PRIVACY_REGISTER) {
  const playable = isRoutePlayable(r);
  const mark = !isDeviation(r.grade) ? "  " : playable ? "OK" : "!!";
  console.log(`${mark} ${r.route}`);
  console.log(`     ${LABEL[r.grade]}`);
  console.log(`     observer sees: ${r.observable}`);
  if (r.disclosure) console.log(`     player is told: "${r.disclosure}"`);
  if (isDeviation(r.grade)) {
    console.log(playable
      ? `     approved by ${r.approvedBy} on ${r.approvedOn} — ${r.rationale}`
      : `     ⚠ AWAITING YOUR APPROVAL — this route stays locked until approved`);
  }
  console.log();
}

const pending = PRIVACY_REGISTER.filter(r => !isRoutePlayable(r));
if (pending.length === 0) {
  console.log("Every deviation is approved and disclosed.");
} else {
  console.log(`${pending.length} route(s) awaiting your approval:\n`);
  for (const r of pending) console.log(`  - ${r.route} (${r.grade})`);
  console.log("\nTo approve: set approvedBy, approvedOn and rationale in");
  console.log("packages/shared/src/privacy-grades.ts, then commit.");
  console.log("Until then these buildings render a locked door, not a downgrade.");
}
' 2>&1
