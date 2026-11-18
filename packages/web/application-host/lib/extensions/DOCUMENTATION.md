# Extensions module

Application Host HTTP routes, plugin-center discovery/release endpoints, scoped credential & event-source bridges, and built-in workbench layout hosting over `@varin/extension-host` and `@varin/extension-contract`. See [docs/extensions.md](../../../../../docs/extensions.md) and [docs/workbench.md](../../../../../docs/workbench.md).

## Key files

| File(s) | Responsibility |
| --- | --- |
| [`routes.ts`](routes.ts) | Authenticated `/api/varin/extensions/v1/*` routes (catalog, host-state, activation, candidate prepare/review/select/apply, local reload, service invoke/lease/routing, workbench profiles/layout, enable/remove/disable-all) and `/extensions/recovery` |
| [`plugin-center-routes.ts`](plugin-center-routes.ts), [`discovery.ts`](discovery.ts) | `/api/varin/extensions/v1/{discovery,releases,updates}` endpoints and official/custom plugin catalog discovery |
| [`credentials.ts`](credentials.ts), [`invocation-principal.ts`](invocation-principal.ts) | `PluginCredentialCapability` and Host-only principal binding for extension capability calls |
| [`event-sources.ts`](event-sources.ts), [`event-transport.ts`](event-transport.ts) | Background plugin event ingress into Catalog and authenticated cross-Host source-ledger transfer |
| [`workbench-layout-service.ts`](workbench-layout-service.ts) | Built-in `varin.builtin.ide-workbench` layout storage service over extension storage CAS |
| [`recovery-page.ts`](recovery-page.ts), [`json-value.ts`](json-value.ts) | Static HTML emergency recovery page (`/extensions/recovery`) and strict JSON-value validation |

## Ownership and invariants

- **Catalog authority & CAS**: `@varin/extension-host` owns catalog storage, package verification, and runtime composition. Mutations require `expectedRevision` (returning `409 revision_conflict` on drift) and reject requests with `503 host_draining` while the Host is shutting down.
- **Install previews**: Release installs (`/releases/preview`, `/releases/preview-archive`, `/releases/install`) pin `previewId`, `expectedHostId`, and `expectedRevision`. Uploaded `.tgz` archives stream to a private `0o600` temp file and are always cleaned up; an HTTP disconnect does not prove a committed catalog write rolled back.
- **Principal isolation**: `invocation-principal.ts` attaches Host-only principal annotations from an authenticated Surface lease or retained Run tool invocation; extension JSON payloads and routing labels can never supply or override a user identity.
- **Background event sources**: `event-sources.ts` forwards plugin ingress into Catalog, which owns subscriptions, checkpoints, content storage, and delivery; `event-transport.ts` transfers source ledgers only between authenticated configured Hosts.
- **Emergency recovery**: `/extensions/recovery` requires session auth and renders a self-contained HTML page (`recovery-page.ts`) that allows inspecting/disabling broken extensions when the normal workbench UI cannot load.
