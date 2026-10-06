# Shared runtime API boundary

Shared UI code can run in Web, Electron-through-Web, hosted mobile, or a Capacitor client.
`@varin/application-client` owns the framework-neutral `RuntimeAPIs` contract
and typed failure shapes; each surface supplies the implementations that actually apply to it.

The former `src/lib/api/*` and `src/lib/runtime-*` forwarding modules have been removed. UI and Web
code import from `@varin/application-client` directly.

## Choosing an owner

| Capability | Owning path |
| --- | --- |
| Pi sessions, models, providers, packages, commands, recovery, and Pi config | Varin protocol through the runtime client, broker, and host |
| Varin capability used by shared React UI | `RuntimeAPIs` from `@varin/application-client`, implemented explicitly by applicable surfaces |
| Web/application-host service | An authenticated `/api/...` route consumed through `runtimeFetch` |
| Browser-owned asset, iframe, download, SSE, or WebSocket | The runtime URL/auth resolver and its owning transport |
| Intentional third-party service | Direct `fetch` with an explicit external-origin and credential contract |

`@varin/application-client` is the shared interface. Web composition lives under `packages/web/src/api`.
Electron normally reuses the Web host; inherently native behavior stays behind
its preload/main boundary.

React code consumes the provider hooks. Non-React owners use the registered API accessor only when a
hook cannot own the lifecycle. Feature code does not read renderer globals directly or recreate a
surface-specific transport.

## HTTP and browser-owned URLs

Ordinary authenticated API calls pass route paths to `runtimeFetch`, which owns endpoint resolution and
HTTP authentication. A browser element that must own a URL—an iframe, download/open link, large raw
asset, SSE connection, or WebSocket—uses `getRuntimeUrlResolver()` and the matching transport helper.
Building a browser URL and passing it back into `runtimeFetch` mixes these two ownership models.

Browser URLs cannot attach the normal authorization header. Varin therefore mints short-lived scoped
`varin_url_token` values through the runtime auth helper. Long-lived bearer tokens never belong in a
URL, and callers do not append the scoped token manually. The application host admits only explicit
browser-readable and realtime paths; see
[the UI auth module](../../../../web/application-host/lib/ui-auth/DOCUMENTATION.md) and
[the relay module](../../../../web/application-host/lib/relay/DOCUMENTATION.md).

Object-URL caches include runtime identity and their real content/version inputs, revoke evicted URLs,
and are bounded when assets can grow. Browser URLs and asset caches are re-resolved after a runtime
switch rather than reused across hosts.

## Runtime switching and parity

`@varin/application-client` changes endpoint/auth ownership and drives established reset/rebind hooks.
Asynchronous work captures the runtime or owner generation it belongs to; a completion from the prior
host cannot commit into the new one. Caches whose IDs or paths can collide include runtime identity.

A shared capability defines the behavior of every surface that consumes it. Unsupported native
behavior is a typed unsupported/absent result, not an empty success or accidental route fallthrough.
Privileged enforcement stays in the trusted host even when the UI also hides or disables an action.
