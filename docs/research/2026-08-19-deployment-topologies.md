# Deployment topology comparison — 2026-08-19

## Scope and non-negotiable requirements

This is a read-only deployment-options comparison for STRKWORLD. It does not
select a provider or configure one. The current repository requires:

- Vite static output and the Node backend behind the same browser origin,
  with private calls at `/api` rather than cross-origin CORS.
- A long-lived WebSocket endpoint for the Colyseus lobby.
- Runtime-only custody for `AVNU_PAYMASTER_API_KEY`, `STARKNET_RPC_URL` and
  `FEE_AUTHORIZATION_SECRET`.
- Exactly one backend/admission-control instance until the D-026 aggregate
  adapters exist.
- A custom domain with TLS, and no `COOP: same-origin` or
  `COEP: require-corp` headers.

The repository's own `docs/OPS.md` remains authoritative for the same-origin,
privacy logging and single-instance constraints. Provider documentation below
was checked on 2026-08-19 and is used only to establish platform capabilities.

## Comparison

| Topology | Static web + `/api` same origin | Long-lived lobby WebSocket | Runtime secrets | One instance/custom TLS | Main unknown or trade-off |
|---|---|---|---|---|---|
| **Fly.io, one public app/Machine** | Supported by hosting one reverse-proxy/static-serving process with the backend and lobby behind it; this composition is application work, not a Fly feature | Fly Proxy routes public HTTP and other protocols; the Node/Colyseus process still needs one public port | Fly encrypts app secrets and injects them as runtime environment variables | One Machine is explicit; custom domains and managed TLS are supported | Must audit Fly/platform access logs and proxy headers for D-014/D-005; a single process/app composition is required |
| **Render, one Web Service** | Supported only by making one web service serve the Vite artifact and reverse-proxy `/api` and WebSocket traffic; Render's static-site + separate-service pattern gives separate public URLs | Render Web Services accept inbound WebSockets | Dashboard/Blueprint environment variables and secret files are available at runtime | Manual scaling can keep one service; custom domains and managed TLS are supported | Static-site rewrites are path rewrites on the static site, not an evidenced cross-service `/api` proxy; platform access-log behavior and header controls need audit |
| **Railway, one Service** | Supported by one service/reverse proxy serving static files and routing `/api` and `/ws`; Railway also documents separate static and application services, which would need an additional same-origin edge | Railway documents WebSocket services and says connections are exempt from inactivity timeouts | Service variables, sealed variables and runtime environment injection are supported | One replica is configurable; custom domains automatically receive SSL | Railway's multi-replica routing is explicitly non-sticky; keep one replica until aggregate state is externalized; platform log/WAF/header behavior needs privacy audit |
| **Vercel static + Functions** | Static output and same-origin function paths are natural, but this would require adapting the Node backend to Functions rather than deploying the repository's container unchanged | **Not a clean fit for this lobby:** current official guidance says Function WebSockets are pinned to a Function only until its maximum duration, then clients must reconnect; the platform also describes Functions as request invocations rather than an always-running process | Function environment variables are available, but build/runtime exposure and secret-handling need a separate review | Custom domains/TLS are standard; one logical Function deployment is not equivalent to one long-lived backend instance | Periodic WebSocket termination, serverless lifecycle and lack of an always-running Colyseus process conflict with the current lobby model and D-026 process-local admission state |

## Topology notes

### Fly.io: single public process

Fly Proxy supports public services, terminates TLS by default for web apps, and
routes connections to Machines. Its app secrets are encrypted and injected as
runtime environment variables; setting a secret restarts the app's Machines.
That fits the repository's runtime secret rule, but the deployment would need a
small public edge process that serves `apps/web/dist`, proxies `/api` to the
backend composition root, and upgrades `/ws` to the lobby. The current backend
and lobby launchers are separate processes, so this is a deployment composition
task rather than a source-code assumption.

Sources: [Fly Proxy](https://fly.io/docs/reference/fly-proxy/), [TLS
termination](https://fly.io/docs/security/tls-termination/), [custom
domains](https://fly.io/docs/networking/custom-domain/), and [app
secrets](https://www.fly.io/docs/apps/secrets/).

### Render: one Web Service versus separate static site

Render explicitly supports inbound WebSockets on Web Services, custom domains,
managed TLS and runtime environment variables. Its documented multi-service
architecture treats a static site and web service as separate public services.
Therefore the straightforward two-service shape does not satisfy STRKWORLD's
same-origin backend rule by itself. A single Docker Web Service can satisfy the
origin requirement if it owns the static file server and reverse proxy, but
that adds an edge process and should be audited for access logs and forbidden
headers.

Sources: [Render WebSockets](https://render.com/docs/websocket), [Web
Services](https://render.com/docs/web-services), [environment variables and
secrets](https://render.com/docs/configure-environment-variables), [static
rewrites](https://render.com/docs/redirects-rewrites), and [multi-service
architecture](https://render.com/docs/multi-service-architecture).

### Railway: one Service versus separate services

Railway documents indefinite WebSocket connections for its WebSocket service
guide, runtime/sealed variables, and automatic SSL for custom domains. It also
documents that requests are distributed among replicas without sticky sessions.
That makes one service with one replica a plausible topology for the current
process-local lobby and aggregate controls. As with Fly and Render, the current
repository needs a small edge/static-serving composition if the backend and
lobby remain separate processes.

Sources: [Railway WebSockets](https://docs.railway.com/guides/socketio),
[variables](https://docs.railway.com/variables), [custom
domains](https://docs.railway.com/networking/domains/working-with-domains), and
[multi-region routing](https://docs.railway.com/guides/multi-region-api-failover).

### Vercel: negative comparator

Vercel now documents public-beta WebSockets for Functions, so it is not correct
to call the feature categorically unavailable. However, its own guidance says
connections close when the Function reaches its maximum duration and clients
must reconnect. The repository's lobby is a long-lived Colyseus server with
process-local room state and process-local admission budgets; adapting it to a
periodically recycled Function would be a new architecture, not a hosting
choice. Vercel is therefore a poor fit for the current unchanged backend/lobby
composition, even though it can serve the Vite static output.

Sources: [Vercel WebSocket support](https://vercel.com/changelog/websocket-support-is-now-in-public-beta), [Vercel WebSocket guidance](https://vercel.com/kb/guide/real-time-chat-websockets), and [Function limits](https://vercel.com/docs/functions/limitations).

## Open checks before choosing

No provider is selected by this note. Before a decision, verify with a minimal
non-secret staging deployment:

1. One public origin serves the Vite artifact, `/api` backend calls and `wss`
   lobby upgrades without a cross-origin redirect.
2. Provider edge/access logs can be disabled or configured so they do not
   retain per-request IPs, paths, timings, recipients, hashes or financial
   material.
3. No platform or CDN adds `COOP: same-origin` or `COEP: require-corp`.
4. Exactly one backend/admission-control instance is running, and deploys do
   not overlap two active instances in a way that breaks D-026 budgets.
5. Secret values are injected at runtime, never as Docker build arguments or
   Vite-exposed variables, and rotation does not require rebuilding the image.
6. Colyseus reconnect, room teardown and custom-domain TLS are tested from two
   browser sessions by the user; rendered browser acceptance remains user-owned.

These checks are operational gates, not permission to configure a provider.
