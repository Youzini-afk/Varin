# Trust & Security Boundaries

Varin reads files, calls models, executes shell commands, and controls desktops. Renderers, remote clients, model tool arguments, project content, network responses, and third-party extensions are untrusted to varying degrees. See [architecture.md](architecture.md), [resources.md](resources.md), and [extensions.md](extensions.md) for the owners that enforce these boundaries.

## Credentials, Secrets & Permissions

- **No secrets in logs**: Never log prompts, API keys, bearer/pairing tokens, `Authorization` headers, arbitrary env vars, or file contents. External models and web services are data sinks, not trusted local stores.
- **Project trust**: Governs executable project resources (instructions, skills, project MCP, actions). Settings or skill text cannot self-grant file, process, or credential access.
- **Not an OS sandbox**: Third-party brokered Host extensions run with the Host's OS account privileges; tool policies, capability tags, and logical resource grants do not isolate hostile native code or arbitrary shell commands.
- **Remote & managed access**: Authenticated routes enforce explicit capabilities and allowed-directory policies with canonicalized paths. A workspace ID, content hash, Thread/Run ID, or matching path string on another Host never grants authority. Revocation blocks new access without rewriting history or faking rollback.
- **Native Workspace mounts**: [native_sources.rs](../kernel/crates/varin-kernel/src/storage/native_sources.rs) validates grant, root, branch, scope, mount generation, and lease together; knowing a mount path or stale generation grants nothing. [workspace_resources.rs](../kernel/crates/varin-kernel/src/workspace_resources.rs) restricts mount/close to the original owner and confines subdir binds inside the real mount.
- **Endpoint isolation**: Distinct URL path prefixes on the same origin are distinct Host endpoints. Realtime proxies attach credentials only to explicit routes under that prefix and never follow redirects. Switching Hosts fails in-flight auth preparation before dispatch so old credentials/bodies never leak to the new Host.

## Renderer & Electron Desktop

- Context isolation is enabled and Node integration is disabled. Preload exposes only validated explicit methods — no generic IPC escape hatch to main.
- Host tokens, custom headers, and local/relay identities stay in main; sensitive bootstrap only targets approved packaged/local/dev origins and never passes via Chromium CLI args.
- Remote pages cannot enumerate saved Hosts or probe arbitrary networks via main. External navigation allows only supported `http(s):` URLs (no `file:`, `javascript:`, or custom schemes).
- Editor saves go through Host Documents; failed atomic replacements preserve the original file.

## Host, Extensions & Private Processes

- **Trust boundaries**: Public Surface routes and extension broker messages are untrusted and validated at entry. The private Host ↔ Rust wire is an authenticated same-build epoch with schema-generated types — domain owners enforce ownership and permissions rather than duplicating generic shape checks across layers (see [performance.md](performance.md#costs-and-boundaries)).
- **Extension realms**: Brokered Host extensions run in supervisor-managed children; isolated Surfaces get only granted capabilities; trusted-native modules have explicit trust/restart semantics. Revocation immediately blocks new calls on live/draining owners without letting a failed candidate retain revoked grants.
- **Private children**: Kernel bootstrap passes fresh local endpoints and a one-time bearer over stdin (control and content channels authenticate the same epoch). Knowledge and semantic stores run in private child owners with no unauthenticated API.
- **Retired grant fields**: Historical session/worker grant fields decode as null on new records; non-null historical fields fail closed without migrating or mutating user assets.

## Network, Recovery & Cancellation

- **Egress**: Host egress enforces destination policy, private/reserved IP restrictions, redirects, and proxy/DNS/TLS rules. Browser cookie access is opt-in.
- **Recovery / Integration**: Requires original Source/root, current maintenance authority, conditional file versions, and real dirty-buffer observation. User confirmation cannot override an unavailable Surface dirty-state barrier.
- **Cancellation**: Cancel intent, observer detach, effect outcome, and confirmed executor stop are separate facts. HTTP abort or IPC loss never proves a process tree, file reader, or input lane has drained.

## Dependencies & Verification

- Manifests, lockfiles, shipped patches, and `scripts/audit-dependencies.mjs` define active fixes and narrow advisory exceptions (see [ops/dependency-updates.md](ops/dependency-updates.md)).
- Targeted security/permission tests prove only the covered paths — not arbitrary third-party code, installers, or physical remote deployments. See [development.md](development.md#verification).
