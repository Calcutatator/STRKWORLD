# AVNU paymaster onboarding and procurement — 2026-08-19

This is a read-only procurement brief. No Portal account was created, no API
key was requested, and no credits or transactions were funded. Sources are
official AVNU documentation and terms, checked on 2026-08-19.

## What STRKWORLD's route needs

The repository's backend holds `AVNU_PAYMASTER_API_KEY` and calls AVNU for
prepared private actions; the browser must never receive that secret. This is
the **gasfree/sponsored** model, not AVNU's gasless token-payment model:

- **Gasfree:** the dApp sponsors all gas, uses Portal plus an API key, and
  pays from its credit balance.
- **Gasless:** the user pays gas in a supported token, requires no API key, and
  is a different product route.

AVNU's paymaster overview makes this distinction explicitly:
[Paymaster overview](https://docs.avnu.fi/docs/paymaster).

## Official onboarding sequence

AVNU's gasfree guide specifies:

1. Open `portal.avnu.fi` and connect a wallet. The account must already be
   deployed; the connected wallet is the Portal login. A multisig can be used
   for team access, and every signer has access.
2. Create an API key in the dashboard and name it by environment, such as
   `staging` or `production`.
3. Test on Sepolia first. The same key works on Sepolia and mainnet; the
   Sepolia endpoint is documented as unlimited/free testing, while mainnet
   consumes credits.
4. For mainnet, add prepaid STRK credits to the API key, approve and confirm
   the funding transaction, and allow roughly 30 seconds for the balance to
   appear.
5. Configure the server-side paymaster client with the key in the
   `x-paymaster-api-key` header and use sponsored fee mode.

Source: [AVNU gasfree integration](https://docs.avnu.fi/docs/paymaster/gasfree).

AVNU also documents the production and Sepolia API environments and says API
keys are required for sponsored transactions and higher integrated limits:
[API overview](https://docs.avnu.fi/api/overview).

## Custody, rotation and controls

The key is a bearer credential for sponsorship and must remain server-side.
AVNU's terms make the operator responsible for confidentiality, all activity
under the key, immediate rotation/revocation after compromise, and security
measures such as server-side use, IP restrictions and rate limiting. The terms
also say AVNU may dynamically limit or block access by wallet, IP, API key,
integration or transaction.

Source: [AVNU Terms, Paymaster and Portal sections](https://docs.avnu.fi/resources/terms-of-service).

The official material does **not** establish that Portal provides a specific
IP/domain allowlist UI for API keys, nor does it document a mint-two-keys
rotation guarantee. Those are procurement questions, not assumptions. The
application-side controls we can establish now are: runtime-only secret
injection, no Vite exposure, backend route limits, per-route policy, aggregate
budget, kill switches and no per-request financial logging.

## Credits and operational risk

Mainnet sponsorship consumes prepaid STRK credits. AVNU's sponsor-activity API
can report transaction counts, gas usage and remaining credits for a key, and
requires the API key. AVNU's terms state that credits are prepaid, generally
non-refundable, may expire under future policies, and can be consumed even for
failed or reverted transactions. The terms also provide no SLA for uptime,
latency, throughput or sponsorship availability.

Sources: [Sponsor activity API](https://docs.avnu.fi/api/paymaster/sponsor-activity)
and [AVNU Terms](https://docs.avnu.fi/resources/terms-of-service).

The Portal docs advertise dashboard burn-rate/runway and sponsorship
analytics. A production operator should decide the initial credit amount,
alert threshold, refill owner, and emergency route kill procedure before
funding mainnet.

## Propulsion option

AVNU documents the Starknet Foundation Propulsion Program as a possible source
of gas subsidies. It requires a separate application, then Portal setup with
an API key marked as a Propulsion grantee. Approval, amount, timing and
eligibility are not established by the documentation as guaranteed.

Source: [AVNU Propulsion Program](https://docs.avnu.fi/docs/paymaster/propulsion-program).

## Unresolved questions for AVNU/procurement

These must be answered by the project owner or AVNU before a live mainnet run:

- Is a second active key supported for mint-then-revoke rotation, and what is
  the revocation propagation time?
- Does Portal expose API-key IP allowlisting, origin/domain restrictions, or
  only application-side controls? The terms recommend IP restrictions but do
  not document a Portal control.
- What are the actual mainnet credit minimum, refill lead time, payment path,
  expiry policy and alert/webhook options?
- Does AVNU provide an account/team recovery path if the Portal wallet is
  unavailable, and can a multisig be the operational owner?
- Does our exact server-side private `apply_action` flow qualify for the same
  sponsored gasfree coverage as the documented generic paymaster examples?
  The docs establish gasfree sponsorship generally, not this project's
  private-action eligibility or limits.
- What are the supported mainnet rate limits, transaction caps and denial
  reasons for this integration?

Until these are answered and the funded D-028 run succeeds, the repository's
backend should continue to fail closed when its key or upstream route is
unavailable. No API key belongs in source, Docker build args, Vite variables,
browser storage or logs.
