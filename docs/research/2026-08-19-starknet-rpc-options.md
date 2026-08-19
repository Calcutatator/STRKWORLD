# Starknet RPC options — 2026-08-19

Read-only comparison for STRKWORLD's mainnet JSON-RPC reads. No provider
account, endpoint, API key or RPC call was created by this research. Provider
documentation was checked on 2026-08-19. This note does not select a provider.

## Hackathon/build-docs check

The official [Starknet Hackathon Re{define} page](https://hackathon.starknet.org/)
advertises a $27,000 prize pool and lists Xverse API-plan/mentorship benefits
only for the top three projects using Xverse in the **Bitcoin** track. It does
not promise participants a Starknet RPC account, free quota, or a production
endpoint. STRKWORLD's privacy/open-track participation therefore cannot treat
the hackathon page as an RPC entitlement.

The official [Starknet full-nodes and RPC services
directory](https://www.starknet.io/fullnodes-rpc-services/) labels Lava
Protocol an “open Starknet RPC endpoint,” but gives no free-tier terms,
authentication policy, quotas, origin controls, retention terms, or production
SLA. The current [Starknet developer integrations
page](https://docs.starknet.io/learn/cheatsheets/integrations) lists open
endpoints as a provider category and specifically says the documented dRPC and
Lava open endpoints are for **Sepolia**; neither page establishes a suitable
unauthenticated mainnet endpoint for this project. An endpoint shown in an
official directory is consequently an example/public listing, not evidence of
free or production-capable service.

Alchemy's current [Starknet RPC page](https://www.alchemy.com/rpc/starknet)
does explicitly say that higher limits and archive data are available “with a
free account” and provides a mainnet endpoint template requiring an API key.
That is a free-tier provider account, not a hackathon grant and not an
unauthenticated public endpoint. It remains the practical development fallback
in this note, subject to the browser/server split, domain/IP controls, privacy
review, quotas, and D-028 funded validation already listed below. No provider
account was created and no endpoint was called for this check.

## Requirements and security split

STRKWORLD needs two deliberately different RPC configurations:

- **Browser RPC:** public by nature because `VITE_STARKNET_RPC_URL` ships in
  the bundle. It needs a domain/origin restriction where the provider supports
  one, and conservative quota/method controls.
- **Server RPC:** private runtime secret used by `apps/backend`. It needs an
  IP-restriction option where the provider supports one, and must remain out of
  Vite, Docker build arguments and logs.

Neither provider controls the application's D-014 privacy boundary. A
provider's access logs, request retention, quotas and abuse controls still
need a contractual/operational review. RPC provider selection does not replace
the backend proxy for privacy-sensitive reads.

## Comparison

| Option | Starknet mainnet | Browser origin/domain control | Server IP control | Quotas / URL credential | D-028 suitability and unknowns |
|---|---|---|---|---|---|
| **Alchemy** | Official Starknet mainnet HTTP and WSS endpoints, with API-key URLs and current RPC-version documentation | Alchemy documents app domain allowlists; missing `Origin` fails when a domain allowlist is set | Alchemy documents IPv4 app IP allowlists | Free/PAYG throughput is expressed in CUPS; API key is in the endpoint path; separate apps can be used operationally for browser/server isolation | Strong fit for separate public/private apps if Starknet endpoints inherit the documented app controls. Confirm exact Starknet app-plan behavior, IP visibility through the deployment edge, retention/logging terms, and current RPC method/version support |
| **QuickNode** | Official Starknet endpoints with HTTP/WSS URLs containing an auth token; multiple RPC versions and credit-based usage | QuickNode documents referrer/domain-mask/security controls in endpoint security material, but the most explicit security pages are generic/plan-dependent; verify Starknet availability in the chosen plan | QuickNode documents IP allowlists and endpoint security rules; plan availability must be confirmed | Rate limits vary by plan; URL token authentication is the basic pattern; method/global rate limits are documented | Potentially strong fit if Starknet endpoints expose the same security controls. Confirm exact Starknet plan, browser referrer/domain semantics, server IP enforcement, data retention/logging and token rotation/multiple-token support before use |
| **Self-hosted Pathfinder/Juno** | Official Starknet docs describe running a full node; its RPC is under project control | No provider-origin allowlist exists. The project must put a narrowly configured public read proxy in front, or avoid direct browser RPC | The project's reverse proxy/firewall can restrict server access by IP; public browser access cannot be IP-restricted to users | No provider quota or URL API key; quotas, rate limiting, logs and key separation become project responsibilities | Maximum control and least provider uncertainty, but materially higher operations: node sync/storage, upgrades, RPC hardening, public proxy, TLS, abuse controls and privacy-safe logging. D-028 still requires mainnet source/funded validation; self-hosting does not prove wallet/paymaster behavior |

## Provider findings

### Alchemy

Alchemy's Starknet documentation lists mainnet HTTP and WSS endpoints in the
API-key URL and recommends the latest supported RPC version. Its security guide
documents app-level domain and IPv4 allowlists, including the important browser
behavior that a missing `Origin` fails when domain restrictions are enabled.
Alchemy's pricing documentation defines throughput in compute units per second
and publishes plan-level CUPS values.

Sources: [Starknet endpoints](https://www.alchemy.com/docs/reference/starknet-api-faq),
[Starknet RPC page](https://www.alchemy.com/rpc/starknet), [allowlist
guide](https://www.alchemy.com/docs/how-to-add-allowlists-to-your-apps-for-enhanced-security),
[pricing plans](https://www.alchemy.com/docs/reference/pricing-plans), and
[compute-unit throughput](https://www.alchemy.com/docs/reference/throughput).

The docs establish the controls at the Alchemy app level; they do not, in the
pages checked, prove that every Starknet plan/version exposes identical
allowlist behavior or provide the retention/access-log terms needed for D-014.

### QuickNode

QuickNode's Starknet endpoint documentation provides HTTP and WSS endpoint
patterns, multiple Starknet RPC versions and plan-dependent credit/rate-limit
usage. Its endpoint-security documentation describes token authentication,
referrer whitelisting, IP allowlists, domain masking, request filtering and
method/global rate limits. The security documentation also warns that some
controls require particular plans.

Sources: [Starknet endpoints](https://www.quicknode.com/docs/starknet/endpoints),
[Starknet quickstart](https://www.quicknode.com/docs/starknet/quickstart),
[endpoint security](https://www.quicknode.com/docs/ethereum/endpoint-security),
[CLI security/rate controls](https://www.quicknode.com/docs/cli/examples), and
[Starknet error references](https://www.quicknode.com/docs/starknet/error-references).

The checked pages do not prove that every generic endpoint-security feature is
available for Starknet on every plan. Treat browser referrer/domain behavior,
server source-IP enforcement, logs/retention and multiple-token rotation as
procurement checks rather than assumptions.

### Self-hosted full node

The Starknet documentation describes running Pathfinder or Juno, including a
Docker path and an Ethereum WebSocket dependency. This removes a third-party
RPC API key but shifts all availability, storage, sync, upgrade, TLS, abuse,
quota, logging and method-filter responsibilities to the project.

Source: [Starknet full-node quickstart](https://docs.starknet.io/secure/quickstart/running-a-node).

Self-hosting should not expose the node's unrestricted RPC directly to the
browser. A public read-only proxy would still be required, with a separate
server-only endpoint and explicit method/rate controls. Whether this is
operationally sensible is a project decision, not established by the node
quickstart.

## Mainnet / D-028 checks before selection

Before choosing a provider, run a no-secret staging probe and confirm:

1. Mainnet supports every exact RPC method used by the browser and backend at
   the selected RPC version, including `starknet_call`, block reads and the
   receipt/status reads actually needed by the current code.
2. Browser and server credentials can be separate, with browser origin/domain
   restrictions and server IP restrictions independently enabled where
   documented.
3. Keys are not exposed in source maps, client logs, error URLs or Docker
   layers; if URL credentials are unavoidable, review proxy/referrer/history
   leakage and prefer a server-only key for private reads.
4. Provider access logs and retention are compatible with D-014, or all
   privacy-sensitive reads remain behind the backend with an approved logging
   posture.
5. Quotas and rate limits cover lobby/game traffic without converting a
   provider 429 into a retry storm or a privacy-sensitive client signal.
6. RPC behavior is tested against the pinned Starknet/mainnet versions. This
   remains separate from D-028's funded Ready/Xverse prompt, Wallet API,
   paymaster and tiny-mainnet transaction validation; an RPC endpoint cannot
   prove those routes.

No provider is selected by this note, and no source configuration is changed.
