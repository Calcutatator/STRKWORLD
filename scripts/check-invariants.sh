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

# 4. Only packages/privacy talks to Starknet. Since D-012 removed the OUT
#    direction, the bridge no longer needs it either — it is 1Click + viem only.
#    apps/web is included: the shell must go through PrivacyOperations, not
#    reach past it to the wallet directly.
if grep -rnE "from ['\"](starknet|@starknet-io|@starknetfoundation)" \
     --include="*.ts" --include="*.tsx" \
     packages/world packages/lobby packages/shared packages/bridge apps/web 2>/dev/null; then
  bad "starknet imported outside packages/privacy"
  note "The shell goes through PrivacyOperations. See docs/ARCHITECTURE.md."
else
  ok "starknet confined to packages/privacy"
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

# 4c. STRKWORLD is a Wallet API dapp, not a key-holding SDK integrator. Pulling
#     in the low-level SDK would move viewing keys, discovery and proving into
#     this repo and violate the first invariant.
sdk_hits=$(grep -rnE "@starkware-libs/starknet-privacy(-sdk)?" \
  --include="*.ts" --include="*.tsx" --include="package.json" \
  packages apps 2>/dev/null || true)
if [ -n "$sdk_hits" ]; then
  printf '%s\n' "$sdk_hits"
  bad "low-level STRK20 SDK in the app — use the Wallet API route"
else
  ok "privacy implementation stays on the Wallet API route"
fi

# 4d. The browser emits capability-bounded domain intents. Raw STRK20 invoke
#     actions belong inside packages/privacy, where targets and calldata can be
#     allowlisted. Exposing them in the shell turns the game into an arbitrary
#     transaction composer and makes D-018 unenforceable.
raw_action_hits=$(grep -rnE "STRK20_(INVOKE_)?ACTION|type:[[:space:]]*['\"]invoke['\"]|calldata[[:space:]]*:" \
  --include="*.ts" --include="*.tsx" apps/web/src 2>/dev/null || true)
if [ -n "$raw_action_hits" ]; then
  printf '%s\n' "$raw_action_hits"
  bad "raw protocol action in the web shell — emit a typed privacy intent instead"
  note "Targets, selectors and calldata are owned and allowlisted by packages/privacy (D-018)."
else
  ok "web shell exposes no raw protocol-action escape hatch"
fi

# 4e. The vendored knowledge layer is part of the project contract. Agents can
#     use it offline, while skills-lock.json records source and content hashes —
#     and those hashes are verified here, not merely recorded (they were wrong
#     from the first commit and nothing noticed; see the 2026-08-16 audit
#     finding).
missing_skills=""
hash_fail=""
for skill in strk20-privacy strk20-wallet-api strk20-anonymizer-contracts strk20-privacy-sdk strk20-privacy-integration; do
  f=".agents/skills/$skill/SKILL.md"
  if [ ! -f "$f" ]; then
    missing_skills="$missing_skills $skill"
    continue
  fi
  want=$(python3 -c "import json,sys; print(json.load(open('skills-lock.json'))['skills']['$skill']['computedHash'])" 2>/dev/null)
  got=$(shasum -a 256 "$f" 2>/dev/null | cut -d' ' -f1)
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    hash_fail="$hash_fail $skill"
  fi
done
if [ -n "$missing_skills" ]; then
  bad "required STRK20 skill missing:$missing_skills"
elif [ -n "$hash_fail" ]; then
  bad "vendored skill content does not match skills-lock.json:$hash_fail"
  note "Either the skill was edited (re-vendor or update the lock deliberately)"
  note "or the lock is stale. Recompute: shasum -a 256 .agents/skills/<name>/SKILL.md"
else
  ok "required STRK20 skills are vendored and match skills-lock.json"
fi

# 5. The lobby never sees money. Checks code, not comments — docs legitimately
#    name these terms in order to forbid them.
#    Matches substrings, not word boundaries: playerAddress, walletAddress and
#    buildingName all slipped through a \b...\b pattern. Building names are
#    forbidden in lobby traffic too (AGENTS.md), so they are in the pattern.
lobby_hits=$(find packages/lobby/src -name "*.ts" -type f 2>/dev/null -exec \
  sed -E 's://.*$::; /^[[:space:]]*\*/d; /^[[:space:]]*\/\*/d' {} + \
  | grep -niE "address|balance|tx_?hash|transaction|private_?key|viewing_?key|building|token|amount|shield" || true)
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

# 7. Supersession must be discoverable from BOTH directions. If a decision says
#    it supersedes D-0NN, then D-0NN's own status line must point forward — an
#    agent reading the old entry first must not act on it unknowingly.
sup_fail=""
for target in $(grep -oE "supersedes D-[0-9]+" docs/DECISIONS.md 2>/dev/null \
                | grep -oE "D-[0-9]+" | sort -u); do
  status=$(awk -v d="## $target " '
    index($0, d)==1 {found=1; next}
    found && /^\*\*/ {print; exit}
  ' docs/DECISIONS.md)
  case "$status" in
    *SUPERSEDED*|*Superseded*|*superseded*) ;;
    *) sup_fail="$sup_fail $target" ;;
  esac
done
if [ -n "$sup_fail" ]; then
  bad "superseded decision(s) with no forward pointer:$sup_fail"
  note "Edit the old entry's status line to point at the one that replaced it."
  note "See the supersession convention at the top of docs/DECISIONS.md."
else
  ok "supersession is discoverable both ways"
fi

# 8. Privacy default is ABSOLUTE. Any route below `private` is a deviation and
#    needs the project lead's recorded approval plus plain-language disclosure.
#    Unapproved means a locked door, never a quiet downgrade.
reg="packages/shared/src/privacy-grades.ts"
if [ -f "$reg" ]; then
  report=$(python3 - "$reg" <<'PYEOF'
import re, sys
src = open(sys.argv[1]).read()

# Brace-depth parser: find each object literal whose first key is `building:`,
# regardless of indentation or formatting. The previous regex only closed a
# block on a line of exactly two spaces + `}`, so ordinary reformatting made
# entries silently invisible to this safety gate (fail-open). This fails
# CLOSED instead: zero parsed entries in a file that mentions `building:`
# is itself a failure. (Known limit: a brace inside a disclosure string will
# confuse the depth count for that entry — keep braces out of the copy.)
blocks = []
for m in re.finditer(r"\{", src):
    start = m.start()
    # A register entry's first key is a QUOTED building id ({ building: 'bank' });
    # the RouteEntry type declaration ({ building: BuildingId }) is unquoted and
    # must not be parsed as an entry.
    if not re.match(r"\{\s*building\s*:\s*'", src[start:start + 60]):
        continue
    depth = 0
    for i in range(start, len(src)):
        c = src[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                blocks.append(src[start:i + 1])
                break

if not blocks and "building:" in src:
    print("PARSEFAIL:yes")
    sys.exit(0)

unapproved, nocopy = [], []
for b in blocks:
    route = (re.search(r"route:\s*'([^']+)'", b) or [None, "?"])[1]
    grade = (re.search(r"grade:\s*'([^']+)'", b) or [None, "?"])[1]
    if grade == "private":
        continue
    approved = re.search(r"approvedBy:\s*'[^']+'", b)
    disclosed = re.search(r"disclosure:\s*\n?\s*['\"]", b)
    if not approved:
        unapproved.append(f"{route} ({grade})")
    elif not disclosed:
        nocopy.append(route)
print("PARSEFAIL:")
print("UNAPPROVED:" + " ".join(unapproved))
print("NOCOPY:" + " ".join(nocopy))
PYEOF
)
  parsefail=$(echo "$report" | grep "^PARSEFAIL:" | cut -d: -f2- | xargs)
  unapproved=$(echo "$report" | grep "^UNAPPROVED:" | cut -d: -f2- | xargs)
  nocopy=$(echo "$report" | grep "^NOCOPY:" | cut -d: -f2- | xargs)

  if [ -n "$parsefail" ]; then
    bad "could not parse the privacy register — check 8 cannot verify D-020"
    note "A gate that cannot read its register must fail, not pass vacuously."
  fi

  if [ -n "$unapproved" ]; then
    bad "privacy deviation(s) with no recorded approval: $unapproved"
    note "These are decisions for the project lead, not tasks."
    note "Run ./scripts/privacy-report.sh and take it to them."
  else
    ok "every privacy deviation is approved"
  fi

  if [ -n "$nocopy" ]; then
    bad "approved deviation(s) still missing player-facing copy: $nocopy"
    note "Approved but undisclosed is still a silent downgrade. Door stays locked."
  else
    ok "every deviation discloses itself to the player"
  fi
else
  bad "privacy register missing: $reg"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "All invariants hold."
else
  echo "Invariant violation. These are defects even if the app runs — see AGENTS.md."
fi
exit "$fail"
