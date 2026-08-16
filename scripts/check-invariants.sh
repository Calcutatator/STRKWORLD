#!/usr/bin/env bash
# Enforces the project invariants from AGENTS.md.
# Runs in CI. Fails loudly rather than letting a boundary erode quietly.
set -uo pipefail
fail=0
note() { printf '  %s\n' "$1"; }
bad()  { printf '\033[31mFAIL\033[0m  %s\n' "$1"; fail=1; }
ok()   { printf '\033[32m ok \033[0m  %s\n' "$1"; }

echo "STRKWORLD invariant checks"
echo

# 1. Web wallets must stay possible: never source connectors from the static list.
if grep -rn "get-starknet-wallets" --include="*.ts" --include="*.tsx" packages apps 2>/dev/null; then
  bad "get-starknet-wallets is a hardcoded 5-wallet registry — use get-starknet-discovery"
  note "Sourcing connectors from it means no new wallet can ever appear."
else
  ok "no static wallet registry import"
fi

# 2. Capability is runtime, never identity.
if grep -rnE "wallet\.(id|name)\s*===|walletId\s*===" --include="*.ts" --include="*.tsx" packages/privacy 2>/dev/null; then
  bad "branching on wallet identity in the privacy path"
else
  ok "no wallet-identity branching"
fi

# 3. Cross-origin isolation breaks web wallets, and we do no in-browser proving.
if grep -rnE "Cross-Origin-(Opener|Embedder)-Policy|require-corp" \
     --include="*.ts" --include="*.tsx" --include="*.json" --include="*.toml" \
     --include="*.conf" --include="*.html" packages apps 2>/dev/null; then
  bad "cross-origin isolation headers break postMessage popups used by web wallets"
  note "See docs/DECISIONS.md D-005."
else
  ok "no cross-origin isolation headers"
fi

# 4. Only chain-facing packages talk to Starknet. The bridge needs it for the
#    OUT-direction ERC-20 transfer; world, lobby and shared never do.
if grep -rn "from ['\"]starknet\|from ['\"]@starknet-io" \
     --include="*.ts" --include="*.tsx" packages/world packages/lobby packages/shared 2>/dev/null; then
  bad "starknet imported outside the chain-facing packages (privacy, bridge)"
else
  ok "starknet confined to privacy + bridge"
fi

# 4b. The bridge must not reach into the STRK20 seam — it is public rails, and
#     conflating the two is how a privacy claim gets made by accident.
#     Matches real import statements only; docs and comments legitimately name
#     the package in order to forbid it.
bridge_hits=$(find packages/bridge/src -name "*.ts" -o -name "*.tsx" 2>/dev/null \
  | xargs grep -nE "^[[:space:]]*(import|export)[^\"']*['\"]@strkworld/privacy" 2>/dev/null \
  || true)
if [ -n "$bridge_hits" ]; then
  printf '%s\n' "$bridge_hits"
  bad "bridge imports the privacy package — it must not touch the STRK20 seam"
else
  ok "bridge independent of the privacy seam"
fi

# 5. The lobby never sees money. Checks code, not comments — docs legitimately
#    name these terms in order to forbid them.
lobby_hits=$(find packages/lobby/src -name "*.ts" -type f 2>/dev/null -exec \
  sed -E 's://.*$::; /^[[:space:]]*\*/d; /^[[:space:]]*\/\*/d' {} + \
  | grep -niE "\b(address|balance|txHash|transactionHash|privateKey|viewingKey)\b" || true)
if [ -n "$lobby_hits" ]; then
  printf '%s\n' "$lobby_hits"
  bad "financial identifier in lobby code — it must never see money"
  note "See packages/lobby/README.md."
else
  ok "lobby carries no financial identifiers"
fi

# 6. Secrets stay out of the tree.
if grep -rnE "g\.alchemy\.com/v2/[A-Za-z0-9_-]{10,}" \
     --include="*.ts" --include="*.tsx" --include="*.json" \
     --exclude=".env.example" packages apps 2>/dev/null; then
  bad "a live RPC key looks committed — rotate it immediately"
else
  ok "no committed RPC key"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "All invariants hold."
else
  echo "Invariant violation. These are defects even if the app runs — see AGENTS.md."
fi
exit "$fail"
