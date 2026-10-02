# ReceiptLedger

The private leaderboard's on-chain half, and STRKWORLD's first own Cairo contract
(D-116, amending D-077). It records one **receipt** each time STRKWORLD sends a
transaction that pays the STRK20 pool fee: shield, unshield, private send, and
the DeFi flows that run through shadow accounts. Players count their own
receipts privately, at the stand near the plaza. The contract never learns, and
never publishes, which account a receipt belongs to.

Mainnet, once deployed: `0x1517eeedc0d7a352e841a87a55312e2e19d28e6d09247822b28d044541766f8`
(class `0x2ae831b0a7419a934c5631b65b78b7beabb08dc0607e0ab08f9c237a2612173`).
The address is fixed in advance: see [How the address is fixed](#how-the-address-is-fixed).

## What it does

`tick(commitment)` is the only write. It is called by a player's STRK20
**shadow account** from inside a pool transaction, as one of that shadow's
`calls`. It:

1. asks the canonical `ShadowAccountAnonymizer` for the shadow deployed under
   `commitment`, and reverts unless that shadow is the caller;
2. reads the pool's fee and, if governance has set it to zero, returns without
   counting (no fee, no receipt; skipping instead of reverting keeps the
   player's action working);
3. reverts if this transaction already produced a receipt (`counted_tx`), so
   one fee is never counted twice;
4. appends the leaf `poseidon(commitment, tx_hash)` to a depth-20 incremental
   Merkle tree (Poseidon, `poseidon_hash_many([left, right])` per node) and
   records the new root as known;
5. increments `count_of(commitment)` and emits `Receipt(commitment, index, leaf, root)`.

Views: `count_of`, `root`, `leaf_count`, `is_known_root`, `is_counted`,
`distinct_commitments`, `anonymizer`, `pool`. The interface is in
[`src/lib.cairo`](src/lib.cairo) (`IReceiptLedger`).

There is no owner, no admin function and no upgrade path. The anonymizer and
pool addresses are constructor arguments and can never change.

**No histogram on-chain.** In receipt mode each action uses a fresh shadow, so
every commitment holds exactly one receipt, and a per-commitment histogram
would only say "everyone has 1". Grouping receipts per player needs the
player's partial commitment `p`, which only their wallet can produce, so the
distribution has to be built off-chain (the Phase 1 tallier) or from Phase 2
claims. The ledger keeps only cheap global totals: `leaf_count` and
`distinct_commitments`.

## Why it cannot be gamed or linked

The chain of authority, each link verified in source and on mainnet:

| Link | Where |
|---|---|
| The pool charges the fee (`collect_fee`) before it applies any action | `privacy.cairo:792` |
| Only the pool may drive the anonymizer (`privacy_invoke_with_computation` asserts the caller) | anonymizer source; live `get_privacy_contract()` = the pool |
| The anonymizer deploys and records the shadow **before** it runs the shadow's calls, so `get_shadow_account(C)` already returns the caller during `tick` | `get_or_deploy_shadow_account`, then `execute` |
| Only the anonymizer may make a shadow call anything (`execute` asserts owner); a shadow has no `__execute__`, so it can never send a transaction of its own | `shadow_account.cairo:83-84` |
| `C = h(h(identity_key, dapp_name), nonce)`, and the pool derives `identity_key` from the signing account inside the proof | `hashes.cairo:48-60` |

So a receipt can only come from a fee-paying pool transaction, and only under a
commitment that belongs to the account that signed it. Nobody can mint
receipts under another player's commitment, and a contract the shadow calls
cannot tick on its behalf, because the caller must be the shadow itself.

**Privacy.** The ledger stores and emits commitments `C`. Each `C` is already
public: it is the deploy salt of its shadow, emitted by the anonymizer's
`ShadowAccountDeployed` event. Linking `C` to an account needs `p`, which needs
the account's viewing key, which stays in the wallet. The ledger adds no link
between an account and a position. Its storage is all derived from public
data: receipt counts per commitment, transaction hashes and Merkle nodes.

**What it does not stop.** Wash trading costs one pool fee (6 STRK today) per
receipt, so scoring and any prize must stay below that cost (research §4).
Both trust anchors, the pool and the anonymizer, are upgradeable by their own
governance. If they change, this contract's guarantees change with them, the
same exposure the Vault already has. A pool or anonymizer upgrade that removes
`get_fee_amount` or `get_shadow_account` makes every `tick` revert, so the web
side must keep receipts behind a switch (`VITE_STRK20_LEADERBOARD_LEDGER`,
unset by default).

## Gas

snforge measures about 1.5M L2 gas per `tick` (20 levels, two Poseidon hashes
each, plus roughly ten storage writes). At the mainnet L2 gas price of
2026-10-02 (about 2.0e-8 STRK per unit) that is about 0.03 STRK, against the
6 STRK pool fee and the roughly 3.6 STRK a private transaction already costs. In receipt
mode the fresh shadow's deployment costs extra, and that cost has not been
measured yet.

## Test

```bash
cd contracts/receipt-ledger
scarb fmt --check && snforge test        # 12 tests
```

The pinned toolchain is in `.tool-versions` (Scarb 2.13.1, Starknet Foundry
0.52.0). CI installs the same versions from checksummed release tarballs
(`scripts/install-cairo-toolchain.sh`).

The tests use a mock anonymizer and a mock pool. They cover: only the genuine
shadow for `C` can tick (not a stranger, not another genuine shadow, not an
undeployed commitment); two ticks in one transaction are rejected; a zero fee
skips without reverting; counts, leaf count and distinct commitments; the root
against an independent full-tree recomputation; the `Receipt` event; and the
Poseidon node hash against starknet.js. snforge 0.52 cannot catch a
constructor panic, so the zero-address constructor check is not tested.

## Deploy (for the lead)

You deploy with your own Argent (Ready) wallet. Nothing here asks for a key:
the page only asks your wallet to sign, and your wallet shows you each
transaction first. Keep at least 10 STRK in the account: a mainnet fee
estimate for the declare on 2026-10-02 was 4.74 STRK (235M L2 gas), and the
deploy costs far less. The wallet shows the exact fee before you approve.

1. In a terminal, from the repo root, serve the deploy page:
   `python3 -m http.server 8787 -d contracts/receipt-ledger/deploy`
2. Open `http://localhost:8787` in the browser where Ready is installed.
   Check the page shows **Starknet mainnet** and contract address
   `0x1517eeed…541766f8`.
3. Click **Connect Ready** (it may show as Argent X) and approve. The wallet
   must be on mainnet.
4. Click **Declare with wallet** and approve the DECLARE transaction. Wait
   until the page says the class is declared (about a minute).
   If Ready refuses or errors, use the fallback below, then reload the page.
5. Click **Deploy with wallet** and approve the single call to the Universal
   Deployer. Wait until the page says the contract is live. Its log should
   say "anonymizer and pool match".
6. Copy the contract address with the **Copy** button and set it as
   `VITE_STRK20_LEADERBOARD_LEDGER` in Railway only when the web side is ready
   to send receipts. Until then, leave it unset.

Stop the server with Ctrl-C when you are done.

### Does Ready support declaring from a web page?

Unconfirmed. Argent's last public extension source (argent-x v5.23.0, March
2025) routes `wallet_addDeclareTransaction` to a declare screen, but the
handler carries a `FIXME: this is a hack. It won't work` comment on how it
passes the class. Ready's current build is not public. Step 4 is the test.
Deploying (step 5) is an ordinary invoke, which Ready certainly supports.

### Fallback if Ready cannot declare

Declaring is permissionless and the class hash depends only on the code, so
any account can declare it, and you can still deploy from Ready.

- **Another wallet on this page.** Connect a wallet that supports declaring
  (Braavos, for example) for step 4 only, then reconnect Ready for step 5.
- **sncast, with your own account.** Run this yourself, from
  `contracts/receipt-ledger`, with an account you have already imported into
  sncast (`sncast account import`). An Argent account with a guardian cannot
  sign from sncast alone, so use an account without one:

  ```bash
  sncast --account <your-account-name> declare \
    --contract-name ReceiptLedger \
    --url https://api.cartridge.gg/x/starknet/mainnet
  ```

  It should print class hash
  `0x2ae831b0a7419a934c5631b65b78b7beabb08dc0607e0ab08f9c237a2612173`. Then
  go back to step 5 on the page. To deploy from sncast instead:

  ```bash
  sncast --account <your-account-name> deploy \
    --class-hash 0x2ae831b0a7419a934c5631b65b78b7beabb08dc0607e0ab08f9c237a2612173 \
    --salt 0x7374726b776f726c642d6c622d6c65646765722d7631 \
    --constructor-calldata \
      0x04f33230dc57855c6e7eabe66dfa0fde82c5458fd0e54827cdb7cb4c474888a7 \
      0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a \
    --url https://api.cartridge.gg/x/starknet/mainnet
  ```

  Leave out `--unique`, so the address matches the one above.

### How the address is fixed

The page deploys through the Universal Deployer with `not_from_zero = false`
and salt `'strkworld-lb-ledger-v1'`. The address then depends only on the
class, the salt and the two constructor arguments, never on who deploys. If
someone else deploys it first, the result is the same contract at the same
address, and the page detects that and shows it as live.

### Rebuilding the page's bundle

`deploy/ledger-artifact.js` holds the compiled class the page declares. After
any change to `src/`:

```bash
(cd contracts/receipt-ledger && scarb --release build)
node contracts/receipt-ledger/deploy/build-artifact.mjs
```

CI fails if the bundle does not match the source (`build-artifact.mjs --check`).
The compiled class hash is Blake2s, which Starknet requires for new
declarations from v0.14.1 (mainnet runs v0.14.3). Scarb's CASM and the
Universal Sierra Compiler 2.9.1's CASM hash to the same value.
