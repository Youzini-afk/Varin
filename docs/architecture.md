# Varin Architecture

Varin consists of a shared workbench UI, a single trusted **Application Host**, and a private **Rust kernel**. Web, Electron, and mobile clients all talk to the same Application Host; there is no second backend or client-side conversation database.

- **Native conversations** execute in the Rust Agent runtime (`varin-runtime`), with Thread, HistoryBranch, Run, Request, and Operation persisted in its Catalog.
- **External harnesses** (Codex, Claude Code, Pi, ACP) keep their own execution loops; Varin persists bindings, deliveries, and observations in the same Catalog without inventing fake native Runs. See [external-agents.md](external-agents.md).
- **Workbench Profiles** (`varin.bot`, `default`, `varin.ide`) only change the UI shell, not execution identity, source, or permissions.

Related guides: [runtime.md](runtime.md) · [resources.md](resources.md) · [retrieval.md](retrieval.md) · [workbench.md](workbench.md) · [extensions.md](extensions.md) · [development.md](development.md)

## Process & Package Boundaries

```text
Web / Electron / Mobile renderer
  @varin/application-client (RuntimeAPIs, DTOs, HTTP + multiplexed observation WS)
    Application Host (packages/web/application-host)
      auth, model accounts, resources, MCP, Documents, research, ComputerService
      extension host & brokered extension children
      private Rust kernel (authenticated local socket / Windows named pipe)
        varin-runtime: Catalog, history, requests, execution engine, durable operations
        varin-kernel:  Storage, files, processes, compute, Host bridges
      private Knowledge owner + separate derived-semantic owner
```

- **`application-client`** defines framework-neutral APIs, DTOs, and typed failures; **`protocol`** holds shared domain/surface types. The private Rust wire is generated from [kernel/protocol/schema.json](../kernel/protocol/schema.json) and is never exposed as a generic renderer RPC passthrough.
- **`ui`** owns React presentation, Thread projections, the client Document Registry, and editor groups — never direct file writes, credentials, or durable execution.
- **`web`** is the Application Host. Electron embeds the same Host and adds native shell, preload, browser views (`WebContentsView`), notifications, and updates; mobile connects to a Host over HTTP/WS or relay.
- **Browser Use & Office**: Embedded Browser Use is owned by Electron's trusted `BrowserOwner` (remote Hosts without it never borrow local browser login state). Office conversion (DOCX/XLSX/PPTX) runs in Host and commits output via native file transactions.
- **Assembly entrypoint**: [application-host/index.ts](../packages/web/application-host/index.ts). Trace owners from there; UI routes, path strings, and type tags never grant authority.

## State Ownership

Each state domain has a single authoritative writer:

| State | Authoritative Owner |
| --- | --- |
| Thread, HistoryBranch, Run, Request, Operation, Wait, queues, usage | Rust `varin-runtime` Catalog & immutable ContentStore |
| External harness bindings, inputs, observations & delegation receipts | Rust Catalog / ContentStore (native session history stays in external harness) |
| WorkingState, blobs, file leases, process receipts, Recovery/Integration | Rust `varin-kernel` Storage |
| Active editor buffers & dirty revisions | Client Document Registry (physical I/O via Host Documents) |
| Directory registration, root admission, versioned doc coordination | Host Documents |
| Model channels, accounts, purpose settings, skills/instructions, MCP | Host domain services (frozen per Run at preparation) |
| Agent notes & standing instruction edits | Host personalization / Rust typed record |
| Environment captures, frozen model representations, input cursors | Rust Catalog / ContentStore |
| Plans, Bot knowledge, symbol graph | Private KnowledgeStore writer |
| Semantic vectors & indexes | Separate derived-semantic process |
| Shell selection, layout & transient UI state | UI kernel & active shell extension |

Catalog ([catalog.rs](../kernel/crates/varin-runtime/src/catalog.rs)) and Storage ([storage/core.rs](../kernel/crates/varin-kernel/src/storage/core.rs)) are separate storage domains with independent schemas and format checks; Storage has no older-format upgrade chain.

Project registrations live in Application Host Settings (shared across clients of that Host); Catalog conversation organization references only `projectId` per authenticated principal. `ProjectEntry.source` binds a `SourceResourceOwner` + target workspace ID (defaulting to local); identical names or paths on different Hosts are never merged.

## Admission, Execution & Observation

1. **Admission**: Host validates real Thread/branch and inputs, prepares models, credentials, Source, policy, and extension candidates. Rust Catalog durably admits and freezes the Run/request config and body; `RunSupervisor` drives the frozen `RunDriver` (built-in Rust loop by default, or trusted `varin.agent.driver@1`). Settings edits never rewrite already-admitted work.
2. **Reads & Projections**: UI queries `ThreadsAPI` for composite snapshots and paged history. Catalog serves metadata on a dedicated read-only connection and reads bodies outside the writer lock.
3. **Observation Bus**: Host reads durable events via a shared reader while enforcing per-observer principal/cursor/interest. Direct browser clients multiplex whitelisted long-lived observations over `/api/varin/observations/ws` (relays reuse the same channel) to avoid HTTP/1.1 connection exhaustion without accepting arbitrary writes. Terminal and voice WebSockets stay separate.
4. **Streaming vs Durable**: Transient tokens, public thinking, and tool args live per-request in streaming state and are replaced when durable history commits. Slow/closed views or disconnects never block or cancel execution. See [runtime.md](runtime.md#reads-and-observation) and [kernel adapters](../packages/web/application-host/lib/kernel/DOCUMENTATION.md).

## Trust, Completion & Storage Upgrades

- **Auth & Ownership**: HTTP auth resolves once per request; routes verify immutable Thread/Run/Operation/Input ownership by declared fields (never by scanning opaque bodies). Private work is isolated per principal; non-owner authenticated users have read-only access to public work. See [ui-auth](../packages/web/application-host/lib/ui-auth/DOCUMENTATION.md) and [ownership-resolver.ts](../packages/web/application-host/lib/kernel/ownership-resolver.ts).
- **Least Authority**: Tool visibility is not permission. Project trust, client identity, tool policy, invocation, and resource owner each enforce their boundary. Capability tags and logical scheduling are not an OS sandbox.
- **Stop vs Cancel**: HTTP abort, cancel intent, and actual executor stop are distinct facts. Original owners retain leases and cleanup until confirmed exit; unknown side effects are never auto-replayed.
- **Upgrades**: Catalog format upgrades run transactionally in [catalog_upgrade.rs](../kernel/crates/varin-runtime/src/catalog_upgrade.rs) before advancing epoch or resuming work. Unknown, newer, or corrupt stores fail closed read-only without mutating user assets.
- **Binary Integrity**: Installed Hosts verify the adjacent Rust executable's build, wire protocol, and architecture manifest.
