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

<PrivacyProvider shellBus={shellBus}>
  <WorldHost out={worldBus} in={shellBus} />
  <PanelLayer world={worldBus} />
</PrivacyProvider>
```

`PrivacyProvider` defaults to `FakePrivacyOperations`. That is the intended
default, not a placeholder: the whole shell is built and tested against the
deterministic fake, and the production adapter implements the same interface,
so switching is one prop at the composition root.

## Panels are state machines with a view on top

Panel logic is a plain state machine over a store — `bank-machine.ts`,
`connect-machine.ts` — and the React component only renders it. Two reasons,
both practical:

- The repository's test runner is Node with no DOM, so the part that decides
  whether to sign a transaction is the part that gets tested.
- The financial state machine outlives whatever the room looks like.

## Rules the code enforces so nobody has to remember them

**A balance read is a wallet interaction.** Ready 5.33.8 raises an explicit
"Share private balances" approval for `wallet_strk20Balances`. Entering the
Bank reads pool config and stops; the balance appears when the player asks, and
returns to unrequested after a submission changes it. There is no timer in this
app, and `bank-machine.test.ts` advances ten minutes of fake time to prove it.

**Never derive MAX from an aggregate.** The shipped Wallet API returns one
figure per token, so the production adapter sets `maturityKnown: false`. When it
does, there is no maximum — not a guess, not the total (D-022). There is also no
maximum for a shield, because the shell cannot see public STRK and D-013's
stranding trap makes the last of it exactly what must not be sent.

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
