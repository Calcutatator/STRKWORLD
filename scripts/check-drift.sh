#!/usr/bin/env bash
# Read-only mainnet asserts. Nothing here writes, spends, or needs a key.
#
# Exists because this project has twice been bitten by a protocol value moving
# while the documentation stayed still. Runs in CI; failing means re-read the
# claim, not that anything is broken.
set -uo pipefail

RPC="${STARKNET_RPC_URL:-https://rpc.starknet.lava.build}"
POOL="0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a"
fail=0

call() { # selector -> hex result
  curl -s --max-time 20 -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"starknet_call\",\"params\":[{\"contract_address\":\"$POOL\",\"entry_point_selector\":\"$1\",\"calldata\":[]},\"latest\"]}" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("result",[""])[0] if "result" in d else "ERR")' 2>/dev/null
}

echo "STRK20 protocol drift canary"
echo "pool $POOL"
echo

# get_fee_amount()
# starknet_keccak("get_fee_amount"), computed with starknet.js — not guessed.
FEE_SELECTOR="0x3d323cd692ad43935b81ce230c47bfc57f69656249c5a33fe5223c17dd32ed2"
PAUSED_SELECTOR="0x238d7ea31550fece8f0a8a601e3ae1a7c59cb3b6cc976ceb721e31ebd9c36f9"
raw=$(call "$FEE_SELECTOR")
if [ "$raw" = "ERR" ] || [ -z "$raw" ]; then
  echo "FAIL  could not read the pool fee (selector or RPC changed) — check by hand"
  fail=1
else
  dec=$(python3 -c "print(int('$raw',16))")
  echo "      pool fee reads $dec"
  if [ "$dec" != "6000000000000000000" ]; then
    echo "DRIFT pool fee moved from 6 STRK to $dec — update D-013 and any economic model"
    fail=1
  else
    echo " ok   pool fee still 6 STRK"
  fi
fi

# The pool must be reachable at all.
cls=$(curl -s --max-time 20 -X POST "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"starknet_getClassHashAt\",\"params\":[\"latest\",\"$POOL\"]}" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("result","ERR"))' 2>/dev/null)
if [ "$cls" = "ERR" ] || [ -z "$cls" ]; then
  echo "DRIFT pool contract did not resolve — it may have been upgraded or paused"
  fail=1
else
  echo " ok   pool class $cls"
fi

# is_paused() — a paused pool means every building stops, and we should know
# before a player does.
paused=$(call "$PAUSED_SELECTOR")
if [ "$paused" = "ERR" ] || [ -z "$paused" ]; then
  echo "FAIL  could not read is_paused"
  fail=1
elif [ "$(python3 -c "print(int('$paused',16))")" != "0" ]; then
  echo "DRIFT pool is PAUSED — every shielded building is down"
  fail=1
else
  echo " ok   pool not paused"
fi

echo
[ "$fail" -eq 0 ] && echo "No drift." || echo "Drift detected. Re-read the claim before trusting any doc that states it."
exit "$fail"
