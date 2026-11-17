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
- `packages/web/application-host/lib/tunnels/providers/reverse-proxy.ts`: unregistered existing-proxy adapter. The Host injects an initially disabled guarded listener, and the adapter exposes its actual backend address. It does not install or configure a proxy, persist settings, or probe a public endpoint.

## Guarded-listener integration boundary

`createTunnelService` accepts an optional Host-owned `getStartContext(request)` for provider backends. When supplied, its values override start options; without it, existing Cloudflare/ngrok loopback behavior is unchanged. Explicit unsupported start providers/modes fail rather than falling back to another provider.

The existing-proxy adapter has its own `reverse-proxy` provider/mode and `reverseProxy` configuration (`publicOrigin`, `backend.host`, `backend.port`). The origin must be HTTPS without credentials, a non-root path, query, or fragment. The backend port is fixed, not dynamically reassigned on conflicts. Only the injected `openPublicIngress` may bind it; the adapter does not create another server or auth owner. That opener must finish binding a **guarded, initially disabled** listener before returning. The adapter enables it after validating the bound port, disables it synchronously on stop, and returns an idempotent asynchronous close operation.

`getPublicUrl()` is an address, not a readiness assertion. `getEndpointVerification()` and the service's `endpointVerification` result are `unverified` for the existing-proxy adapter; legacy providers return `null` until they supply evidence. Public HTTPS, current-Host identity, and full proxy reachability have not been checked merely because the local listener is bound.

The adapter is intentionally **not registered in the Host**. Registration requires persistent settings/enable intent through the existing settings writer, public-entry authentication, status consumers that distinguish unverified endpoints, and lifecycle handling that awaits asynchronous listener closure. The current synchronous service stop and URL-based routes are not sufficient for that integration. No FRP, SSH deployment, automatic restoration, or public-endpoint verification is implemented here.

## Public exports (`routes.ts`)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`
