# Authoring Varin extensions

Varin extensions customize the Varin application host and workbench. They are a separate product
object from Pi packages: installing or disabling a Varin extension never installs, disables, or
rewrites a Pi package. A repository may publish both, but each keeps its own manifest, lifecycle,
configuration, and update policy.

This guide covers the public authoring path. It does not require imports from `packages/ui`, private
React components, or a source checkout of Varin.

## Planned public packages

| Package | Use |
| --- | --- |
| `@varin/extension-contract` | Browser-safe manifest, contribution, service, routing, workbench, and discovery DTOs plus JSON schemas |
| `@varin/extension-sdk` | Framework-neutral managed, isolated, and Host activation contexts |
| `@varin/extension-sdk/testing` | Surface, isolated-realm, and brokered-Host lifecycle conformance harnesses |
| `@varin/extension-surface` | Surface owner lifecycle and registry substrate for advanced tests or alternate hosts |
| `@varin/extension-react` | Optional React 19 adapter; React is not part of the core contract |
| `@varin/extension-cli` | `init`, `check`, `build`, and `test` author workflow |

These packages are prepared for public AGPL-3.0-only distribution but are not published to npm yet.
Once available, extension code should import the SDK and contract, not Varin's product UI.

## Create a project

```sh
npx @varin/extension-cli init ./my-extension \
  --id dev.example.my-extension \
  --name "My Extension"
cd my-extension
npm install
npx varin-extension build
npx varin-extension test
```

`init` is deliberately non-interactive and refuses to overwrite a non-empty directory. The generated
project is a complete managed Surface extension with a standalone `varin.extension.json`, source,
build mapping, TypeScript configuration, and package metadata.

Optional `--template` values:

| Template | What it generates |
| --- | --- |
| `surface` | Default managed Surface page contribution |
| `shell` | Framework-neutral `workbench.shell` replacement using `defineShellMount` |
| `editor` | Custom resource editor selected by language or filename |
| `view` | Sidebar view on `workbench.primary-sidebar.views` |
| `language` | Brokered Host language provider using `defineLanguageProvider` |
| `debug` | Brokered Host debug adapter using `defineDebugAdapter` |
| `test` | Brokered Host test provider using `defineTestProvider` |

Shell, editor, and view templates import only `@varin/extension-sdk` and
`@varin/extension-contract`. They must not import Varin's React product UI. Documents, terminals,
and sessions stay in Core even when a community Shell fully redraws the chrome.

## Workbench SDK

`@varin/extension-sdk` re-exports workbench targets, slots, context keys, and the `default` /
`varin.ide` profile IDs. Use:

- `defineSurfaceMount` / `defineShellMount` / `defineViewMount` / `defineEditorMount` for DOM, Canvas, or any framework
- `createWorkspaceDocumentsClient` for resource-scoped, revisioned document reads and writes
- `createWorkspaceLanguageClient` / `defineLanguageProvider` to register a Host-side language server
- `createWorkspaceDebugClient` / `defineDebugAdapter` to register a Host-side debug adapter
- `createWorkspaceTestClient` / `defineTestProvider` to register a Host-side test provider
- `@varin/extension-sdk/testing` fixtures for enable/disable leak checks, async mount abort, profile switch without mutating desired enablement, and expected-revision document conflict

`@varin/extension-react` remains optional. `defineReactShell`, `defineReactView`, and
`defineReactEditor` wrap the same mount contract. `defineReactShell` provides a
`VarinWorkbenchCompositionHost` to the Shell component via React context; use
`useWorkbenchCompositionHost()` to access it and mount child replacements or slots into DOM
containers without importing `@varin/ui`. Child mounts follow selected contribution generations
and are automatically disposed when the Shell unmounts; retaining the returned handle is only needed
when the Shell wants to dispose that host point earlier. Calls are limited to seams declared by the
Shell contract and accept JSON-safe props only. Isolated iframe/Worker Shells are self-contained in
v1 and do not receive this parent-realm DOM composition host.

### Shell seam contract

A `shell` contribution must declare a `VarinWorkbenchShellContributionDataV1` data payload that
lists which replacement targets and slots the shell supports per surface. The contract is validated
at manifest parse time. Shells that do not declare a target for the current surface will not see
that target in the Extensions settings page, and any existing selection for it is preserved as
dormant. The six IDE structural targets (`workbench.activity`, `workbench.primary-sidebar`,
`workbench.editor`, `workbench.secondary-sidebar`, `workbench.panel`, `workbench.status`) are
real `WorkbenchReplacement` hosts in the IDE shell. The `editorActions` and `panelViews` slots
receive JSON-safe props defined in `@varin/extension-contract`
(`VarinWorkbenchEditorActionsSlotProps`, `VarinWorkbenchPanelViewsSlotProps`).

Animation does not impose an official page structure on a Shell. The versioned Transition Scene and
future optional Motion-service boundary are specified in
[Varin Motion and replaceable transition scenes](../design/varin-motion-platform.md). A complete Shell owns
its internal elements and animation; Varin only coordinates cross-owner handoff.

### Transition Scene

A `transition-scene` contribution replaces `workbench.transition` without requiring either Shell to
render a particular element. Its serialized descriptor declares the scenes and their real phase
durations. Zero means immediate completion; Varin does not impose a guessed maximum duration.

```json
{
  "contractVersion": 1,
  "data": {
    "contract": "varin-transition-scene/v1",
    "scenes": ["workbench-profile"],
    "durations": {
      "workbench-profile": {
        "covering": { "quick": 900, "standard": 1800, "reduced": 0 },
        "revealing": { "quick": 900, "standard": 1800, "reduced": 0 }
      }
    }
  },
  "entrypoint": "dev.example.motion.main",
  "id": "dev.example.motion.transition",
  "kind": "transition-scene",
  "replacement": { "target": "workbench.transition" },
  "supports": ["desktop", "web"]
}
```

Managed extensions mount once for the complete transaction and subscribe to a stable controller:

```ts
import { defineSurfaceExtension, defineTransitionSceneMount } from "@varin/extension-sdk"

export default defineSurfaceExtension((context) => {
  context.contribute({
    contractVersion: 1,
    data: {
      contract: "varin-transition-scene/v1",
      scenes: ["workbench-profile"],
      durations: {
        "workbench-profile": {
          covering: { quick: 900, standard: 1800, reduced: 0 },
          revealing: { quick: 900, standard: 1800, reduced: 0 },
        },
      },
    },
    id: "dev.example.motion.transition",
    kind: "transition-scene",
    replacement: { target: "workbench.transition" },
    supports: ["desktop", "web"],
  }, defineTransitionSceneMount((container, mount) => {
    const render = () => {
      const frame = mount.props.transition.getSnapshot()
      container.dataset.phase = frame.phase
      container.dataset.direction = frame.direction
    }
    const unsubscribe = mount.props.transition.subscribe(render)
    render()
    return () => {
      unsubscribe()
      container.replaceChildren()
    }
  }))
})
```

The scene may call `transition.complete(transitionId, phase)` when its current covering or revealing
animation finishes. If it does not, Varin advances at the duration declared in the selected
artifact. The controller rejects a completion from an older transition or phase. Profile persistence,
candidate Shell ownership, failure rollback, and the final handoff remain Core responsibilities.

Language, debug, and test helpers accept either a static descriptor or a function receiving the
brokered Host context. Use `context.assets.path("runtime/server.mjs")` for an executable shipped in the
extension package. Varin resolves the path inside the immutable selected artifact; it is not relative
to the workspace, application process, or private artifact layout. Package-relative paths cannot
escape the extension package.

An `editor` contribution declares at least one `data.languageIds` or `data.filenames` selector and may
set a finite `data.priority`. It is a resource provider, not a toolbar action, so it does not need a
Workbench slot. `defineEditorMount` receives a stable `mount.props.document` controller. Subscribe to
it, read `getSnapshot()`, apply offset edits with the current `documentVersion`, and save with the same
expected version. Varin keeps the buffer, dirty state, conflicts, recovery journal, and disk revision
authoritative; the custom editor only owns its view. If the contribution is disabled, updated, or
fails to mount, that editor view falls back locally without dropping the document or layout.

Offsets are zero-based UTF-16 code units, matching JavaScript string indexing. Every edit in one call
targets the same captured version:

```ts
const snapshot = mount.props.document.getSnapshot()
const result = await mount.props.document.applyEdits([
  { from: 0, to: 4, insert: "Varin" },
], snapshot.documentVersion)

switch (result.status) {
  case "applied":
    break
  case "stale":
  case "conflict":
  case "invalid-range":
  case "overlapping-ranges":
  case "unsupported":
    // Re-render from result.snapshot and show the actual rejection.
    break
}
```

`replaceContent(content, expectedDocumentVersion)` remains a convenience for simple or low-frequency
custom editors. It returns `updated`, `stale`, `conflict`, or `unsupported`; it does not bypass the
same document authority.

An isolated iframe editor receives a `varin-message` event whose value is a
`VarinIsolatedEditorMountMessage`. It then uses its granted `workspace.documents` Surface capability
with the supplied resource identity. Reads include the current Varin buffer and `documentVersion`;
writes must include both `expectedRevision` and `expectedDocumentVersion`, so an isolated realm cannot
silently overwrite a newer local edit.

Do not publish a new npm tag from this handoff. The coordinated next public version is **0.2.0** for
`extension-contract`, `extension-sdk`, `extension-react`, `extension-cli`, `extension-surface`, and
`extension-host`. Wait for an explicit publish approval.

## Manifest authority

`varin.extension.json` is the authoritative package contract. `package.json` remains npm/package
metadata; its version must match the manifest version.

```json
{
  "$schema": "https://raw.githubusercontent.com/Youzini-afk/Varin/main/packages/extension-contract/schema/varin.extension.schema.json",
  "schemaVersion": 1,
  "id": "dev.example.memory-workbench",
  "displayName": "Memory Workbench",
  "version": "1.2.0",
  "engines": { "varin": ">=0.1.0 <0.2.0" },
  "metadata": {
    "description": "A custom memory workspace",
    "homepage": "https://example.dev/memory-workbench",
    "repository": "https://github.com/example/memory-workbench",
    "icon": "assets/icon.svg",
    "keywords": ["memory", "workspace"]
  },
  "entrypoints": {
    "host": {
      "file": "dist/host.cjs",
      "mode": "brokered",
      "activation": ["service-request"]
    },
    "surfaces": [
      {
        "id": "dev.example.memory-workbench.main",
        "file": "dist/surface.cjs",
        "mode": "managed",
        "supports": ["desktop", "mobile", "web"]
      }
    ]
  },
  "requires": {
    "services": [{ "id": "varin.sessions", "version": 1, "binding": "single" }]
  },
  "provides": {
    "services": [{ "id": "dev.example.memory", "version": 1, "multiple": true }]
  },
  "capabilities": {
    "host": ["extension-storage"],
    "surface": ["notifications"]
  },
  "storage": { "schemaVersion": 1 },
  "integrates": { "piPackages": ["pi-observational-memory"] }
}
```

The parser in `@varin/extension-contract` is the runtime authority. The published schema supplies
editor completion and diagnostics. npm, Git, local directories, and built-in distributions all
resolve the same manifest; a source string or display name is never extension identity.

Manifest IDs, entrypoint IDs, contribution IDs, and service IDs use lowercase namespaced identifiers.
Contribution IDs must be qualified by the extension ID. Entrypoint files are forward-slash relative
paths and cannot escape the package.

`integrates.piPackages` is discovery/navigation metadata only. It does not grant access to a Pi
package and does not couple either lifecycle.

## Execution modes

An extension can declare any combination of Host and Surface entrypoints.

### Surface modes

- `declarative`: data-only contributions from the manifest; no extension JavaScript executes.
- `managed`: a framework-neutral bundle runs in the Surface realm. Varin tracks SDK registrations,
  while raw browser effects must register a disposer.
- `isolated`: an application-host-materialized IIFE runs in a sandboxed iframe or Worker and
  communicates through a versioned MessagePort. Realm destruction provides physical unload. Authors
  publish an ordinary browser module; the application host creates the final realm bundle once.
- `native`: explicitly trusted same-realm code. Varin withdraws tracked effects, but cleanup failure
  truthfully becomes `restart-required`.

### Host modes

- `brokered`: runs in a supervisor-owned Node process and uses capability/service/storage RPC. The
  process boundary isolates crashes and lifecycle, but it is not an operating-system sandbox.
- `native`: explicitly trusted application-host code for operations that genuinely require ambient
  host access. Updates take effect after host restart and cleanup remains cooperative.

Capability grants are recorded per manifest version and realm. A first installation that requests
capabilities remains disabled until every request has an explicit allow/deny decision. A candidate
that asks for a new capability cannot activate until every added capability has a decision. Completing
review does not execute code; update application is a separate explicit action.

`workspace.documents` is a Host capability for revisioned, resource-scoped document access. Use
`callWorkspaceDocuments` from `@varin/extension-sdk`. Reads distinguish missing, empty, binary,
undecodable, and failed results. Watch events carry metadata only and never include file bodies.

## Managed Surface entrypoint

```ts
import { defineSurfaceExtension, defineSurfaceMount } from "@varin/extension-sdk"

export default defineSurfaceExtension((context) => {
  context.contribute({
    contractVersion: 1,
    data: {},
    id: "dev.example.my-extension.page",
    kind: "page",
    supports: ["desktop", "mobile", "web"],
    title: "My Page",
  }, defineSurfaceMount((container, mount) => {
    container.textContent = String(mount.props.title ?? "My Page")
    return () => { container.textContent = "" }
  }))

  context.onDispose(() => stopExternalBrowserEffect())
})
```

SDK contribution, service, asset, style, and lifecycle registrations belong to the current owner
generation. Activation stages them and publishes them atomically. Disable or update withdraws them
before reverse-order cleanup. A late completion from an old generation cannot publish into the new
one.

Raw timers, listeners, framework roots, browser objects, or external effects created outside an SDK
helper remain the author's responsibility. Register their cleanup with the Surface lifecycle or the
returned activation disposer.

`defineSurfaceMount` is the public rendering boundary. Varin supplies the actual `HTMLElement`,
current contribution props, owner generation, a mount-scoped `AbortSignal`, and `reportError`. The
extension owns everything it creates inside that container, including a framework root, and returns a
sync or async disposer. Varin aborts and disposes the mounted instance exactly once when props or
owner generation change, the contribution is withdrawn, or the extension is disabled. The optional
React adapter implements this contract with an extension-owned React root; it does not share the
workbench's React singleton.

### Activation events

Manifest contributions are indexed without loading executable code. An executable entrypoint with no
activation list, `application-startup`, or `background` starts eagerly. Entrypoints declaring
`command`, `contribution-visible`, `workspace-match`, or `service-request` stay inactive until that
actual event occurs. The declared contribution remains visible while its executable implementation is
inactive. Disabling clears the trigger latch, so re-enabling does not silently reuse a prior event.

## Isolated Surface entrypoint

```ts
import { defineIsolatedExtension } from "@varin/extension-sdk"

export default defineIsolatedExtension((context) => {
  context.contribute({
    contractVersion: 1,
    data: {},
    id: "dev.example.my-extension.isolated-page",
    kind: "page",
    supports: ["web"],
  })

  if (context.capabilities.has("notifications")) {
    void context.capabilities.call("notifications", "show", { message: "Ready" })
  }
})
```

Isolated code has no ambient Varin object graph. Assets, services, and privileged operations use the
provided clients. Ambient network entrypoints are unavailable in the standard isolated realm; request
a concrete capability when network access is part of the extension contract.

## Optional Monaco editor service

An extension that augments the official desktop/Web editor instead of replacing it declares the
Surface-local service as optional:

```json
{
  "requires": {
    "services": [
      { "id": "varin.editor.monaco", "version": 1, "optional": true }
    ]
  }
}
```

Use the typed SDK helper from either a managed or isolated activation:

```ts
import { createVarinEditorMonacoClient, defineSurfaceExtension } from "@varin/extension-sdk"

export default defineSurfaceExtension(async (context) => {
  const editor = createVarinEditorMonacoClient(context)
  const active = await editor.getActiveView()
  if (active.status !== "ready") return

  await editor.setDecorations({
    sourceId: "review",
    expectedViewGeneration: active.view.generation,
    expectedDocumentVersion: active.view.documentVersion,
    decorations: [{
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } },
      isWholeLine: true,
      className: "dev-example-review-line",
    }],
  })
})
```

The v1 contract contains only serialized active-view identity/snapshot, selection/range, focus,
reveal, set-selection, action execution, and declarative decoration set/clear operations. Results are
`ready`, `absent`, `stale`, or `unsupported`. The service never exposes a raw Monaco editor/model,
`HTMLElement`, callback registration, file/process authority, or `RuntimeAPIs` entry. Managed and
isolated extensions get the same subset; a managed extension does not receive an undocumented DOM or
callback escape hatch.

`getState()` returns the current Surface-local view revision. `waitForState({ afterRevision })` resolves
when that revision changes, so an extension activated before any file opens can follow later view
registration, focus, model, and selection changes without polling on a timer. Owner disposal resolves
an outstanding wait as stale.

Varin creates the service from the runtime-supplied consumer owner. Extension code cannot forge that
owner. Decoration `sourceId` values are scoped to it, and failed activation, candidate rollback,
generation replacement, or disable clears the owner's registrations. The service may be present while
the official Monaco provider has no active view; that truthful state is `absent`. On Surfaces without
the service, the optional requirement does not block activation. A retained client from a withdrawn
owner returns `stale: owner-generation-changed` and cannot keep operating on the current editor.

## Brokered Host entrypoint

```ts
import { defineHostExtension } from "@varin/extension-sdk"

export default defineHostExtension(async (context) => {
  context.services.provide(
    { id: "dev.example.my-service", version: 1, multiple: true },
    { read: () => context.storage.snapshot.document.data },
  )

  await context.storage.update(
    { started: true },
    context.storage.snapshot.document.revision,
  )

  context.effect(() => stopOwnedHostResource())
})
```

Host service methods receive `(args, call)`, where `args` is the JSON argument array and
`call` contains `callId` and a cooperative `AbortSignal`. For example,
`read: async ([path], call) => readFile(path, { signal: call.signal })`.
Clients continue to use `service.call("read", path)`. The call context is separate from JSON
arguments and is available in both brokered and trusted-native modes. Cancellation requests
are delivered to the executing handler; the invocation remains in flight until that handler
settles or its process exits. A handler that ignores the signal is not reported as stopped,
and aborting a signal does not undo an already dispatched external effect.

Host storage is extension-namespaced, revision checked, and authoritative at the application host.
Use the snapshot revision for every update. Missing, ready, and stale storage states are distinct.

New code can open independent documents with
`await context.storage.open({ scope, key, schemaVersion? })`. Supported scopes are `application`,
`profile`, `workspace`, `surface`, and `session`; arbitrary keys let one extension separate unrelated
state without inventing one product-wide schema. Every document has its own revision and update
stream. Varin injects the current extension ID, so the request cannot address another extension's
namespace. `context.storage.snapshot` and `update` remain the `application/state` compatibility
document.

If the manifest storage schema version changes, export `migrate({ data, fromSchemaVersion,
toSchemaVersion })`. Candidate migration is staged with activation; failed candidate activation keeps
the selected generation and selected storage state.

Required services control activation and dependency-safe teardown. Optional services do not block
activation. Multi-provider services publish stable `providerKey` identities; invocation resolves the
latest provider generation through application-host routing. Extensions do not inspect or prioritize
one another.

`binding: "single"` requires exactly one compatible provider across Host, Surface-local, and active
Surface providers. `binding: "selected"` requires an explicit persisted provider selection and never
falls back to an arbitrary provider merely because one is present. `binding: "all"` exposes every
compatible provider through `useServices`.

## Build mapping

The manifest names published artifacts. `package.json` can map each entrypoint ID to source:

```json
{
  "varin": {
    "build": {
      "entrypoints": {
        "host": { "source": "src/host.ts" },
        "dev.example.my-extension.main": { "source": "src/surface.ts" }
      }
    }
  }
}
```

`varin-extension build` bundles Host code for Node 22 and Surface modules for ES2022 browsers. It
writes exactly the manifest paths and never runs package lifecycle scripts. Installation later
materializes immutable, content-addressed artifacts, verifies their integrity, and converts an
isolated module into the one final IIFE owned by its iframe/Worker realm.

The output format follows the target extension (`.cjs` or `.mjs`) and otherwise `package.json`'s
`type`. In a `"type": "module"` package, use a `.cjs` manifest target when the published entrypoint
must be CommonJS.

Files listed by `package.json.files` alongside `dist` remain package assets. The generated language
and debug templates publish their runnable starter adapter under `runtime/` and resolve it with the
Host asset API. The generated Node test template uses `kind: "node-test"`, so it needs no extra process.

## Context expression (`when`)

A contribution may declare a structured `when` expression that controls its visibility based on
workbench context keys. The expression is evaluated by the Surface runtime against the current
context key store; contributions whose `when` evaluates to `false` are hidden but remain in the
registry — their replacement selections are preserved and fall back to available candidates.

The `when` field accepts a `VarinContextExpressionV1` object with one of five operators:

| Operator | Fields | Semantics |
| --- | --- | --- |
| `defined` | `key` | True when the key exists in the context |
| `equals` | `key`, `value` | True when the key exists and its value strictly equals `value` |
| `not` | `expression` | Negation of the inner expression |
| `all` | `expressions` | True when every expression is true (empty array is true) |
| `any` | `expressions` | True when at least one expression is true (empty array is false) |

```json
{
  "when": {
    "op": "all",
    "expressions": [
      { "op": "defined", "key": "editorIsOpen" },
      { "op": "any", "expressions": [
        { "op": "equals", "key": "language", "value": "markdown" },
        { "op": "equals", "key": "language", "value": "typescript" }
      ]}
    ]
  }
}
```

`when` is allowed on all contribution kinds except `shell` and `transition-scene`. Context changes
on those kinds would bypass Workbench Profile stage-and-commit and Recovery invariants. The
manifest parser rejects `when` on disallowed kinds at parse time.

Managed extensions publish custom values with `context.context.set("ready", true)` and reference the
fully namespaced key, for example `dev.example.my-extension.ready`, from `when`. The writer adds the
extension prefix itself. Candidate writes remain invisible until activation and catalog commit both
succeed; candidate failure preserves the old generation's values. After replacement or disable, stale
writers return `false` and cleanup affects only that exact owner/entrypoint generation. Isolated
extensions use `await context.context.set(...)` / `delete(...)` with the same semantics.

## Contribution compatibility

Each contribution declares a `contractVersion` alongside its `kind`. The runtime checks
compatibility before validating kind-specific data. A contribution with an unknown
`contractVersion` is still parsed (structure, id, kind, supports) so the catalog can retain the
record, but its data payload is not validated and it is not visible in the Surface. The CLI
`check` command reports these as `incompatibleContributions` in its JSON output and exits non-zero for
the current Varin target. The installed Catalog record and Profile references remain intact, while
the Surface reports `unsupported-contract-version` and does not register or execute that contribution.

## Check and test

```sh
varin-extension check
varin-extension build
varin-extension test
```

`check` validates the contract, version agreement, path containment, and published entrypoint files.
The JSON output includes `incompatibleContributions` (contributions with unknown contract versions
that are parsed but not executable), `missingFiles` (referenced entrypoint files that don't exist),
and `referencedFiles` (all declared entrypoint file paths). A check with incompatible contributions
still succeeds (exit 0) because the manifest is structurally valid.
`test` rebuilds and executes the public conformance harnesses:

- managed/native Surface activation, committed contribution/service state, deactivation, and leak
  detection;
- isolated module activation, contributions, and reverse-order cleanup;
- brokered Host activation, revisioned storage, service registration, abort, and cleanup with no
  privileged capability implementations.

`runEditorExtensionConformance` adds a real mock public document controller. It verifies incremental
`applied`, `stale`, `conflict`, `invalid-range`, `overlapping-ranges`, and `unsupported` results, then aborts and
disposes the mounted editor instance. Use it alongside browser interaction tests for an editor
contribution; it does not emulate a browser layout engine.

Extensions can call the same harnesses directly from `@varin/extension-sdk/testing` for richer
fixtures. These are contract tests, not a substitute for browser tests of the extension's own UI.

All four author commands accept `--quiet` for a stable compact result or `--json` for a single JSON
success/error value. These modes run the same validation and lifecycle checks as human output and keep
non-zero exit codes on failure.

## Native Agent policy decisions

A brokered Host extension can provide `varin.agent.policy@1` with the SDK's `provideAgentPolicy`.
Select it through ordinary project/session service routing. The native Run pins the selected
artifact, immutable configuration and private-state version; updates use the existing installer
and candidate lifecycle. No separate policy registry, credentials or filesystem capability is needed.

Policies can request the selected model, settle its registered tool exchange, submit a fixed-source
read graph before/between model requests, inspect committed own-Run result chunks, and request a
model with core-resolved evidence references. Graph eligibility belongs to the trusted executor;
MCP metadata cannot make a tool eligible. Large evidence stays in the core content store and enters
the request as external data. See the [installed evidence-policy example](../../examples/extensions/evidence-policy/README.md)
for the build/install route, complete content-dependent sequence, API fields and recovery boundary.
Installation alone does not switch the product's default runtime to the native path.

For auxiliary planning, declare `capabilities: ['agentPlanning']` in the implementation passed to
`provideAgentPolicy`. Omit it for policies that do not need another model. The existing global
Harness model slot owns selection and enablement; it never defaults to the main model. The immutable
view exposes `model_capabilities` with `capability_id`, `purpose: 'planning'`,
`supported_operation: 'tool_free_text'`, and a status of `available`, `disabled`, `unconfigured`,
`invalid` or `unavailable`. Provider configuration and credentials remain private to the Host/core.

Return `request_model_job` with the admitted `capability_id`, nonempty `instructions` strings and
owned `evidence` references. Core freezes task context and runs an independent tool-free operation;
`decide()` must not perform direct model/network work. `model_job_completed` delivers an `action_id`
and typed `receipt` with `dispatch`, `outcome`, scoped `output`, `usage`, `finish_reason`, `failure`
and `usable`. Read a successful committed result using the same scoped `read_result` chunks, then
validate the model-derived data against the policy's declared format before choosing another action.
Neither model output nor a parsed plan grants permissions. Auxiliary tool calls are never executed.
See the [installed planning-policy example](../../examples/extensions/planning-policy/README.md) for
explicit model configuration, normal installation/routing, budgets and the complete content-dependent
planning → evidence graph → main-answer path. Cancellation, pinned generations and epoch fencing
remain part of the existing operation lifecycle, not an extension-owned task or credential store.


## Install and development workflow

Open **Settings → Varin Extensions → Install or update** and choose npm, Git, or local folder. The
specifier is passed to the application-host package source resolver; the UI does not maintain an
allowlist. For a local folder, the application host reads the real project directory and builds a new
immutable content-addressed artifact without copying or modifying the working tree. If `package.json`
declares dependencies, install them in the project first; Varin never runs `npm install` in a local
extension project.

An installed local extension has a **Reload local directory** action. Reload resolves the complete
source identity already stored in the application-host catalog, so the UI neither receives nor
resubmits the hidden path specifier. Unchanged content is a no-op. Changed content with no new
capability request is applied to the current Surface through the normal candidate transaction; a
failed candidate keeps the selected artifact and active generation. A candidate that adds a
capability is only staged for review and still requires the explicit **Apply update** action afterward.

An extension without requested capabilities is enabled on first installation. An extension that
requests Host or Surface capabilities is installed disabled; decide every request in its card, then
enable it with the ordinary lifecycle switch. A denial is still a completed decision—the extension
may activate with only the capabilities actually granted and must handle their absence.

The application host owns installation and execution. Switching the active Pi runtime does not move
or reinstall Varin extensions. Web/cloud and Electron-hosted Web use the server application host.
A Surface reports unsupported/waiting state when
an entrypoint or capability is unavailable there instead of disabling compatible Surfaces.

An external source cannot stage a candidate over a distribution-owned built-in ID. Built-ins are
updated by the Varin distribution; authors provide an alternative extension/contribution ID and let
the user select that replacement explicitly.

## Candidate updates

Installing a source whose manifest ID already exists stages a candidate rather than overwriting the
selected version.

1. The host validates the manifest, engine range, artifacts, integrity, and capability delta.
2. Added capabilities receive explicit decisions in the Extensions page.
3. **Apply update** persists application intent, stages Host and all compatible entrypoints in the
   initiating Surface, and selects the candidate only after staging and validation succeed.
4. **Discard update** removes the candidate record and its prepared generation.

Failure preserves the selected artifact, desired state, active generation, storage, and layout.
Immutable content-addressed files may remain in the application-host cache; they are not active or
selected extension records.

Review completion never applies an update by itself. A trusted-native Host update records the apply
request and reports `restart-required`; the application host completes that already-requested update
on restart. Staged or merely reviewed native candidates do not move on restart.

## Inspector and diagnostics

The Extension Inspector uses public host and Surface state. It shows:

- selected version/source/integrity and candidate artifact facts;
- Host and Surface owner realms, generation, current status, update timestamp, and cleanup generation;
- manifest and live dynamic contributions, including slot placement and replacement targets;
- the active Shell contribution and whether the inspected extension owns it;
- the active Shell's declared targets/slots, dormant Profile selections, and managed child mounts with owner generation;
- document, language, debug, and test service ownership from granted capabilities and live Host providers;
- live Host and Surface service providers;
- optional Monaco active-view and owner-scoped decoration registration counts;
- required services and companion Pi-package metadata;
- capability decisions and extension-attributed catalog/runtime diagnostics.

Diagnostics remain attributed to extension, entrypoint, realm, and generation. The Inspector does
not scrape private plugin databases, package working trees, credentials, or Pi session content.

## Disable, remove, and retained data

The switch changes desired enablement and reconciles Host/Surface generations without refreshing the
document. Installed, enabled, and active remain separate facts. Disabling preserves extension storage,
layout references, service routing rules, and package artifacts.

Remove first deactivates the extension and then deletes its catalog installation record. Built-in
distribution extensions cannot be removed through this action; they can be disabled or omitted by a
distribution. The removal dialog makes the data choice explicit: **retain data** is the default, while
**delete extension data** removes only that extension's validated Varin storage namespace after the
catalog record is removed. Neither choice deletes project files, Pi package data, plugin-native data,
workspace files, or shared artifact-cache material.

## Workbench distribution profiles

Workbench profiles can store both layout/replacement selections and an explicit `extensionIds` set.
Editing the set does not silently change lifecycle. **Apply set** performs one revision-checked catalog
mutation and reconciles the result. Missing extension IDs remain profile references so reinstalling a
package can restore the intended distribution.

The Extensions page supports creating, selecting, applying, and removing profiles. User and workspace
layout selection remains separate from application-host desired extension state; this avoids a hidden
global enable/disable when one window changes its workspace layout.

## Optional discovery catalogs

`@varin/extension-contract` exports `parseVarinExtensionDiscoveryDocument` and the
`@varin/extension-contract/schema/discovery` JSON schema. A discovery document contains presentation
metadata plus a complete npm, Git, local, or built-in source specifier. A catalog entry is a shortcut
that fills an ordinary install request. It is never an allowlist and grants no capability or trust.

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "dev.example.my-extension",
      "displayName": "My Extension",
      "description": "A custom workspace extension",
      "source": {
        "kind": "npm",
        "display": "@example/varin-my-extension",
        "specifier": "npm:@example/varin-my-extension"
      }
    }
  ]
}
```

Catalogs are optional metadata distribution. Direct npm, Git, and local installation remains a
first-class workflow even when no catalog contains the extension.

## Publishing checklist

1. Keep `package.json` and manifest versions equal.
2. Declare only capabilities the entrypoints actually call.
3. Bundle framework dependencies; do not rely on Varin's React or internal packages.
4. Include `varin.extension.json`, built entrypoints, styles, and referenced assets in the package.
5. Run `varin-extension test` and the extension's own UI/integration tests.
6. Install the resulting npm/Git/local source in a clean Varin application host and inspect every
   supported Surface.
7. Stage an update and verify both apply and discard behavior before publishing it as the default.

Varin's complete lifecycle, trust, data-ownership, contribution, workbench, and routing architecture
is recorded in [varin-extension-platform.md](../design/varin-extension-platform.md).

## Varin public tooling releases

Varin maintainers publish the five public authoring packages as one exact-version set:
`extension-contract`, `extension-surface`, `extension-sdk`, `extension-react`, and `extension-cli`.
Prepare the next version with:

```sh
bun run release:npm:prepare 0.2.0
```

This updates all five manifests and their exact internal dependency versions, then refreshes the Bun
lockfile. Review and commit those changes on `main`. Pushing the matching dedicated tag starts the
release:

```sh
git tag -a npm-v0.2.0 -m "Publish Varin npm tooling 0.2.0"
git push origin npm-v0.2.0
```

`.github/workflows/npm-publish.yml` accepts only `npm-v*` tags whose source commit is already on
`main`. It tests and builds the public packages, packs the exact tarballs, installs and exercises them
in a disposable project, preserves the artifacts in GitHub Actions, and publishes in dependency
order. A rerun skips a version only when npm reports the same immutable integrity; an existing version
with different bytes fails closed.

The workflow uses npm Trusted Publishing with GitHub OIDC. It has no `NPM_TOKEN`, browser approval, or
GitHub Environment gate. Each package trusts repository `Youzini-afk/Varin`, workflow filename
`npm-publish.yml`, no environment claim, and the `npm publish` action. GitHub obtains a short-lived
credential for each run, and npm attaches provenance automatically.
