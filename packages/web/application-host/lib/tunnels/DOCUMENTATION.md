# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for Varin, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

## Entrypoints and structure
- `packages/web/application-host/lib/tunnels/index.ts`: tunnel service orchestration.
- `packages/web/application-host/lib/tunnels/executable-search.ts`: cross-platform executable discovery, including Windows Store app aliases.
- `packages/web/application-host/lib/tunnels/registry.ts`: provider registry.
- `packages/web/application-host/lib/tunnels/managed-config.ts`: managed remote tunnel token/preset persistence runtime.
- `packages/web/application-host/lib/tunnels/install-help.ts`: provider/platform install command metadata for missing tunnel dependencies.
- `packages/web/application-host/lib/tunnels/routes.ts`: tunnel API route registration and request orchestration runtime.
- `packages/web/application-host/lib/tunnels/types.ts`: tunnel constants, normalization, and shared type helpers.
- `packages/web/application-host/lib/tunnels/providers/cloudflare.ts`: Cloudflare tunnel provider implementation.
- `packages/web/application-host/lib/tunnels/providers/ngrok.ts`: Ngrok quick tunnel provider implementation.
- `packages/web/application-host/lib/tunnels/providers/reverse-proxy.ts`: existing-proxy adapter for the self-hosted lifecycle. The Host injects an initially disabled guarded listener, and the adapter exposes its actual backend address. It does not install or configure a proxy, persist settings, or probe a public endpoint.

## Guarded-listener integration boundary

`createTunnelService` accepts an optional Host-owned `getStartContext(request)` for provider backends. When supplied, its values override start options; without it, existing Cloudflare/ngrok loopback behavior is unchanged. Explicit unsupported start providers/modes fail rather than falling back to another provider.

The existing-proxy adapter has its own `reverse-proxy` provider/mode and `reverseProxy` configuration (`publicOrigin`, `backend.host`, `backend.port`). The origin must be HTTPS without credentials, a non-root path, query, or fragment. The backend port is fixed, not dynamically reassigned on conflicts. Only the injected `openPublicIngress` may bind it; the adapter does not create another server or auth owner. That opener must finish binding a **guarded, initially disabled** listener before returning. The adapter enables it after validating the bound port, disables it synchronously on stop, and returns an idempotent asynchronous close operation.

`getPublicUrl()` is an address, not a readiness assertion. `getEndpointVerification()` and the service's `endpointVerification` result are `unverified` for the existing-proxy adapter; legacy providers return `null` until they supply evidence. Public HTTPS, current-Host identity, and full proxy reachability have not been checked merely because the local listener is bound.

The adapter is intentionally **not registered in the legacy Cloudflare/ngrok registry**. The self-hosted lifecycle below calls it directly because legacy stop and URL-based status do not represent asynchronous release or endpoint verification. The adapter itself does not run the public HTTPS check; the assembled Host owner below does.

## Public exports (`routes.ts`)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`

## Self-hosted management

`self-hosted-access` assembles the Host-owned guarded listener and the existing-proxy adapter or operator-provided FRP child. `external-access-runtime` owns serialized activation, fenced teardown, rollback, and persistent recovery with capped backoff; configuration and intent use the existing settings file owner with compare-and-swap. The management API accepts local or remote operators with the existing Host-wide connection permissions and uses separate save/enable/disable/retry actions. The snapshot's active revision lets the UI offer an explicit apply action when saved changes are pending. Runtime state distinguishes an enabled external listener from a connected managed FRP session. The optional diagnostic uses a single-use HTTPS proof with normal certificate verification; split-horizon/private DNS is supported and a failed check never changes forwarding state. Runtime changes invalidate the settings view through the existing Host event stream. Legacy starts reserve the external-access slot through the original tunnel service.

Managed frpc supports Windows, Linux and macOS. Runtime configuration uses FRP's native
environment template with a JSON-encoded token, so quotes and template characters remain
data and no token file or credential argument is needed. Explicit component installation
verifies the pinned official archive and extracts only the selected executable, including
the Windows ZIP member. Temporary network failures keep reconnecting while enabled;
credential/configuration failures await an operator change.

Self-hosted entries consume services already configured by the user or their separately instructed
agent. They do not inspect or provision a VPS over SSH, generate deployment plans or receipts, manage
certificates, update remote services or uninstall them. Public HTTPS verification checks the current
application path and Host identity, not server inventory or future certificate renewal. Ordinary SSH work
connections remain with `connections`.

Cloudflare/ngrok retain their existing settings and credentials. Enabling a new entry does not migrate
an external origin or convert legacy in-memory tunnel sessions into persistent browser grants. Browser
pairing, expiry, sign-out and device revocation stay with the existing authentication owners; disabling
ingress closes its connections without deleting device grants or cancelling accepted Agent work.
