# @strkworld/web

**The shell. Composes everything.**

Providers, routing, layout, and the event bus. Owns the building panels and the
batch accumulator that sits between the game and the financial seam:

- **The batch accumulator** — collects player intent during a building visit
  and emits one atomic `Intent[]` on confirm. This is the only lever against
  per-action prompts and fees, so it is load-bearing for the economy.

The shell emits only typed intents. It never accepts a raw contract target,
selector or protocol argument blob, and it never falls back to unshielding and
calling a protocol publicly. An unavailable private route means a locked
building (D-018).

The submission queue is backend-owned on prepared Wallet API paths, bounded by
proof validity, and never delays quote-bound AVNU actions (D-015). Entering a
building separately suspends lobby presence; other players seeing the avatar
disappear is accepted for v1 (D-019).

---

## Layout

| Path | What lives there |
|---|---|
| `src/bus/` | The typed event bus implementation. The shell owns it and hands it to the world |
| `src/world/` | `WorldHost` — acquires and releases the world. React never owns the game lifecycle |
| `src/store/` | A 40-line observable store, plus its `useSyncExternalStore` hook |
| `src/accumulator/` | The batch accumulator |
| `src/connect/` | Capability detection, and the rooms for a wallet that cannot help |
| `src/panels/` | The building-panel framework, the privacy gate, and the rooms |
| `src/privacy/` | The seam context, failure classification, build context, and the register import |
| `src/receipts/` | The receipt ledger — receipts outlive the panel that made them |
| `src/panels/bank/` | The Bank: shield, unshield, private transfer |
| `src/copy.ts` | Every player-facing string the shell owns |
| `src/format.ts` | `bigint` ↔ display. No `number` anywhere near money |

## Composition

The shell does not mount itself. Whoever owns the composition root wires the
three pieces together, which keeps world mounting and panel rendering
independent of each other:

```tsx
const worldBus = createEventBus<WorldEvents>();
const shellBus = createEventBus<ShellEvents>();

<PrivacyProvider operations={ops} shellBus={shellBus}>
  <WorldHost out={worldBus} in={shellBus} />
  <PanelLayer world={worldBus} />
</PrivacyProvider>
```

**There is no default seam.** `operations` is required unless `demo` is set
explicitly, and `demo` throws in a production build. A fallback that quietly
supplied the fake would mean a mis-wired build showing a working Bank holding
250 STRK nobody owns — money-shaped fiction in a product whose whole claim is
that it moves real funds.

For local work, `<PrivacyProvider demo fallback={…}>` loads
`FakePrivacyOperations` through a dynamic import. The whole shell is built and
tested against that fake and the production adapter implements the same
interface, so switching is one prop.

## Panels are state machines with a view on top

Panel logic is a plain state machine over a store — `bank-machine.ts`,
`connect-machine.ts` — and the React component only renders it. Two reasons,
both practical:

- The repository's test runner is Node with no DOM, so the part that decides
  whether to sign a transaction is the part that gets tested.
- The financial state machine outlives whatever the room looks like.

Render rules get their own `.test.tsx` files. They use `react-dom/server`'s
`renderToStaticMarkup` with a machine driven into the state under test and
passed in — no jsdom, no testing-library, no new dependency. A correct machine
rendered wrongly is its own class of defect, and it is the one this lane
actually shipped: a disclosure keyed to a tab, a maximum that always failed, a
confirm button that survived its own click.

## Rules the code enforces so nobody has to remember them

**A balance read is a wallet interaction.** Ready 5.33.8 raises an explicit
"Share private balances" approval for `wallet_strk20Balances`. Entering the
Bank reads pool config and stops; the balance appears when the player asks, and
returns to unrequested after a submission changes it. There is no timer in this
app, and `bank-machine.test.ts` advances ten minutes of fake time to prove it.

**A receipt is not panel state.** A transaction settles whether or not the room
is still on screen, and the panel's lifecycle is not the player's decision — the
world emits `building:exited` and `PanelLayer` unmounts the panel. So the hash is
recorded in the provider's receipt ledger the instant the seam returns, before
any liveness check, and a reopened room finds it there. For the same reason a
batch already handed to the wallet is never discarded: discarding cannot unring
that bell, and the seam is entitled to treat a discarded batch as unsubmittable,
which would turn "the player left the room" into "the transaction never
happened". The close control stays enabled and says what closing does and does
not do; disabling it would trap the player behind a wallet that may never answer
and would be theatre anyway.

**Never state a maximum that has to be guessed.** Three separate cases, one
rule. The shipped Wallet API returns one figure per token, so the production
adapter sets `maturityKnown: false` — then there is no maximum, not a guess and
not the total (D-022). There is no maximum for a shield, because the shell
cannot see public STRK and D-013's stranding trap makes the last of it exactly
what must not be sent. And there is no maximum for a visit shape that has not
been costed: the pool fee *and* the network cost come out of the same shielded
balance, the seam reports the network cost only at prepare time, and it varies
with batch shape because the relay fee is per action. So a quote is evidence
about one shape, kept keyed by the sorted intent kinds, with no interpolation
between observations. What is already queued counts too — cancelling a review
does not empty the visit.

**The confirm button lives in `ConfirmGate`, and nowhere else.** It takes the
approved disclosures for the batch being committed as a required prop and
renders them immediately above itself. Disclosures follow what is *queued*, not
what control was last touched — otherwise queuing a shield and switching tab
hides the disclosure while leaving the deposit confirmable.

**Move state before you await, and guard everything after one.** A guard that
reads the flow, awaits, and then transitions is not a guard: two clicks in one
tick both pass it. Past that, three separate clocks decide whether a finished
async step may write what it learned — a newer attempt, a closed panel, or a
newer balance read. One counter for all three would mean a balance read
cancelling a submission, which is worse than the bug it fixes.

**No runtime import of `@strkworld/privacy` in the shell.** Its entry point
re-exports the wallet adapter, which pulls `starknet`; a single value import
puts all of it in the entry chunk. Types are erased and free, failures are
classified structurally in `src/privacy/errors.ts`, and the demo seam is loaded
dynamically. `architecture.test.ts` enforces it, along with the rule that
exactly one file deep-imports `packages/shared`. It counts `import … from`,
`export … from` and bare `import 'x'`, and matches subpaths — all three were
escape hatches in an earlier version of that test.

**The demo seam needs naming, and cannot ship.** `detectBuildContext` fails
closed: only an explicit development signal counts as development, because
`import.meta.env` is absent outside Vite and "cannot tell" must not permit
balances nobody holds.

**Disclosures are imported, never written here.** The approved strings live in
`packages/shared/src/privacy-grades.ts` (D-024). `copy.test.ts` fails if any of
them is restated in shell copy.

**"Your wallet", never "your extension".** v1 ships against browser wallets, but
the forward-compatibility design exists so a web or embedded wallet works with
no rewrite (SPEC §5 rule 5). Also enforced in `copy.test.ts`.

**No prompt counting.** Prompt sequence is a source-derived expectation awaiting
the funded run (D-028), so the prepared summary drops `promptCount` and every
pending state on screen is driven by the operation's own stage.

**A locked door has nothing behind it.** No "continue anyway", no public
alternative. That is the failure D-018 and D-020 exist to prevent.

## What this must never do

- Contain business logic that belongs in a package
- Set `COOP: same-origin` or `COEP: require-corp` — they break web wallets
  and we do not need them. There is a CI check
- Expose a paymaster key to the browser bundle. It is proxied server-side
- Import `starknet` or a wallet package. Everything goes through
  `PrivacyOperations`, and CI check 4 fails the build otherwise
- Poll for a balance, or read one to detect a capability
