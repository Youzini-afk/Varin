# @varin/extension-sdk

Framework-neutral authoring API for managed, isolated, and brokered-Host Varin extensions.
Extensions export an `activate` function or use `defineSurfaceExtension`, `defineIsolatedExtension`,
or `defineHostExtension`. Activation contexts own contributions, services, disposers, authenticated
assets, styles, revisioned storage, and capability clients without importing Varin's product UI.

Managed Surface extensions write custom context keys with `context.context.set(localKey, value)` and
`delete(localKey)`. Varin prefixes the extension ID, stages candidate values until activation commits,
and returns `false` to a disposed or superseded writer. Isolated extensions receive the same owner-scoped
client through their message bridge; its `set` and `delete` methods return promises.

Host extensions open independent namespaced documents with
`await context.storage.open({ scope, key, schemaVersion? })`. Each document client exposes its own
snapshot, refresh, revision-checked update, and schema version. Varin injects the extension ID, so
an extension cannot address another extension's namespace. `context.storage.snapshot/update` remains
the compatibility client for `application/state`; new code should use `storage.open(...)` explicitly.

`defineSurfaceMount` creates a framework-neutral contribution implementation. Its `mount(container,
context)` callback receives an ordinary `HTMLElement`, contribution props, owner metadata, a
mount-scoped `AbortSignal`, and `reportError`; it may return a synchronous or asynchronous disposer.
Varin aborts and disposes that mounted instance when its props or owner change, the extension is
disabled, or the host unmounts it. DOM, Canvas, Web Components, and framework-owned roots can all use
the same contract without importing Varin's React or private UI.

`defineTransitionSceneMount` specializes that boundary for `transition-scene` contributions. It
receives one stable external-store controller for the full cover/covered/reveal transaction; the
scene owns its pixels while Varin retains Profile commit and failure recovery. No official Shell
element names are part of this contract.

`@varin/extension-sdk/testing` exports managed Surface, isolated Surface, and Host conformance
harnesses with real owner cleanup semantics. See the complete
[authoring guide](https://github.com/Youzini-afk/Varin/blob/main/docs/ops/varin-extension-authoring.md).

Granted Host extensions can call `workspace.documents` through `callWorkspaceDocuments` or
`createWorkspaceDocumentsClient` for resource-scoped, revisioned document access. The capability never
returns file bodies in watch events, and it cannot escape the workspace the application host resolved.

`callWorkspaceSearch` / `callWorkspaceLanguage` and `createWorkspaceLanguageClient` reach the
host-owned search and language services. `defineLanguageProvider` registers a Host language server.
Language servers are spawned only in the application host; untrusted workspaces cannot execute
project-provided server commands. A provider may supply JSON `initializationOptions`; packaged tools
should resolve executables and fallback runtimes through `context.assets.path(...)` so enable, disable,
update, and rollback remain generation-scoped. Search failures are distinct from zero matches.

`callWorkspaceDebug` / `createWorkspaceDebugClient` / `defineDebugAdapter` and
`callWorkspaceTest` / `createWorkspaceTestClient` / `defineTestProvider` register Host-side
debug adapters and test providers. Those processes are spawned only in the application host.
`defineDebugAdapter` and `defineTestProvider` unregister on dispose through `context.effect`.
Renderers never start a debugger, test runner, or task process.

Brokered Host code resolves packaged executables with `context.assets.path("runtime/tool.mjs")`.
The returned path belongs to the immutable selected package artifact and does not depend on the
workspace working directory. Provider helpers accept either a descriptor or a context factory.

Public workbench constants (`VARIN_WORKBENCH_REPLACEMENT_TARGETS`, `VARIN_WORKBENCH_SLOTS`,
`VARIN_WORKBENCH_CONTEXT_KEYS`) are re-exported from this package. `defineShellMount`,
and `defineViewMount` share the generic mount contract. `defineEditorMount` additionally types
`mount.props.resource`, `viewId`, and the stable document controller used to subscribe, update with an
expected `documentVersion`, and save. Editor contributions declare `data.languageIds` or
`data.filenames`; they are mounted as resource providers rather than in an action slot.

Custom editors can use `document.applyEdits(edits, expectedDocumentVersion)` for incremental writes.
`replaceContent` remains available for simple or low-frequency editors. Both return typed stale,
conflict, and unsupported outcomes instead of treating a rejected write as success.

`createVarinEditorMonacoClient(context)` resolves the optional owner-bound
`varin.editor.monaco` v1 service for managed or isolated Surface extensions. The helper exposes the
same serializable active-view/action/decoration subset in both modes. `getState` plus revisioned
`waitForState` follows later view registration/focus/selection changes without a timer or callback
escape hatch, and the client returns `absent` when a
managed Surface does not inject the optional service. It does not invent managed-only raw Monaco,
callback, or DOM access. `@varin/extension-sdk/testing` also exports
`runEditorExtensionConformance` and a real mock document controller covering incremental failures and
mount abort/disposal.

`provideAgentPolicy` implements `varin.agent.policy@4` at committed execution boundaries. Its
immutable declared configuration and versioned private JSON state are distinct from core history;
the Host pins exact package/configuration identity for each committed policy generation. Declare auxiliary
model duties with `modelRoles`. Optional `transitionState` returns only compatible private state or an
incompatibility reason; omitting it rejects cross-implementation preservation, including null state.
The SDK freezes inputs and checks the result shape, but compatibility semantics belong to the author.
Core captures the original checkpoint, waits for a real closed boundary and commits activation. An
explicit restart clears only policy state and never resumes a Pause. Return a permitted action rather
than calling models or tools in the decision handler. Core validates exchanges, permissions,
registered waits and cancellation. [The bounded evidence example](../../examples/extensions/evidence-policy/README.md)
shows bounded evidence, [the collaboration example](../../examples/extensions/collaboration-policy/README.md)
shows direct child dispatch and observation, and [delivery with explicit pause](../../examples/extensions/delivery-pause-policy/README.md)
shows independent output and the original Run/Wait resume boundary. These examples do not switch the
product's default runtime or give the policy ownership of core history.

`provideRetrievalPlan(context, { configurationId, structure })` registers an immutable
`varin.retrieval.plan@1` declaration with matching `inspect` schemas. Select `structure: 'builtin'`
for the existing native structure stage or `'disabled'` for keyword-only retrieval. Do not perform
filesystem, model, index or other external work during declaration. The Host supplies stages and
keeps a generation pin for each native query; ordinary extension replacement preserves existing
queries, while explicit disable/crash revokes their bindings. See the
[authoring guide](../../docs/ops/varin-extension-authoring.md#native-retrieval-plans) for routing.

`provideTool(context, declaration, execute)` registers an ordinary Host service with `inspect` and
`execute` methods. Import the service descriptor directly from the package's `varin.extension.json`
so cold discovery and activation use one declaration. `execute(input, call)` receives normal JSON,
cooperative cancellation and `call.capabilities`, a client bound to that invocation. Schema compilation
and admission remain with the executing Host; the SDK never owns history, Operations or resource facts.
Return the tool's JSON data directly. Null and empty results are valid; missing/non-JSON results fail.
For Result callbacks, use `await call.output({ kind: 'text', text })` or
`await call.output({ kind: 'media', media: { media_type, data_base64 } })` for explicit ordered
presentation parts. The original completion retains one `{ data, parts }` body; a returned
JSON object that resembles a media descriptor remains ordinary data. Accepted parts survive
callback or output-schema failure with the actual failure receipt. Producers cannot author
storage references, source identity, outcome, effect or stop evidence through this callback.
Declarations support `completion: result` and independent `completion: job` with an explicit
`lifetime: thread | environment`. A Job needs a trusted domain adapter that durably accepts the original
invocation and owns its cancellation/recovery; returned extension JSON cannot create an execution owner
or assert physical stop. A Job callback cannot append parts through `call.output`: its
owning domain must include them in the original durable acceptance or terminal body. Changing an
already accepted Job's content would break its canonical receipt identity. The ordinary [research example](../../examples/extensions/research-tools/README.md)
uses that boundary for accepted experiments and observation waits. This is not a generic extension-owned
durable job store. A declared read operation
still needs its ordinary capability grants and the Host's current invocation authority.

Tool callbacks can inspect their exact accepted directory with `await call.tools.list()` and
`await call.tools.describe(name)`. Both require the existing `runtime.tools` capability and a live
invocation. Results identify `origin: 'accepted_run'`, the original Run ID and tool-schema generation;
listing returns short names/versions/descriptions, while describe returns the original complete
`ToolSchema` or null for an unselected name. These reads do not select or enable anything. The
original parent-operation/executor identity and cancellation fence remain authoritative.

The ordinary `runtime_contract` tool exposes those same reads with `{ action: 'list', kind: 'tool' }`
and `{ action: 'describe', kind: 'tool', name }`. Its service/UI queries instead identify
`origin: 'current_catalog'`: installed declarations, original scoped routing and observed owner
lifecycle. Current metadata is not a promise that a tool is in this Run or that invocation is permitted.
See [runtime contract discovery](../../docs/ops/varin-extension-authoring.md#runtime-contract-discovery)
for method/event schemas and UI author seams.

Tool callbacks can compose other selected tools with
`await call.tools.invoke({ callId: 'memory', name: 'memory', arguments: { action: 'read' } })`.
Declare `runtime.tools` in the Host entrypoint's capabilities. The returned `NestedToolReceipt`
contains `operationId` and the original `completion` (`not_dispatched`, `result`, or `job_accepted`).
Result and optional accepted-Job content use `{ data, parts }`; nested media is resolved for
this original caller. It is not automatically copied to the outer completion. Forward a
selected part through `call.output`, passing only its incoming byte fields; the runtime
assigns the outer source and preserves the inner operation's separate receipt.
The native owner derives the schema version and binds the call to the original invocation's frozen
selected directory, source, context and generation. Every inner tool performs its own ordinary
permission and resource admission; the composition does not enable an unselected tool.

Choose a stable `callId` within this callback. Repeating it with identical input shares the actual
in-flight call or receipt; changed input is rejected. Returned callbacks close new calls and drain
already accepted calls even if their JavaScript promises were abandoned. Foreground cancellation
reaches the original inner executor. An accepted independent Job keeps its original lifetime.
Callback success describes the callback itself: an inner error caught or omitted from output still
has its own native Operation and receipt. Closed or restarted invocation scopes cannot issue calls
or replay unknown effects. See the [nested-tools example](../../examples/extensions/nested-tools/README.md).

To stage an authored package through an ordinary tool invocation, use
`call.tools.invoke({ callId: 'stage-package', name: 'extension_package', arguments: {
  action: 'stage', packagePath: 'my-extension', expectedRevision: catalogRevision
} })`. The original invocation source supplies the files; no Host path or grant can be passed.
First installation is disabled until the user enables it in Extensions and reviews any requested
capabilities. `apply` takes the exact candidate identity and current catalog revision, retains the
existing capability decisions, and never enables a new package. Its committed application request
can survive cancellation and resume on restart. A selected artifact is distinct from actual Host or
Surface activation. The [authored panel example](../../examples/extensions/agent-authored-panel/README.md)
uses the same package, build, tool, view and disposal contracts as other extensions.


`provideContextFragments(context, { sections })` supplies a frozen
`varin.context.fragments@1` declaration. Its manifest uses `VARIN_CONTEXT_FRAGMENTS_SERVICE`, including
`contract.composition: "ordered"`, to allow explicit ordered routing. The body/method stays v1.
Each provider owns its section names; identical names in different providers remain distinct.
Instruction/data roles are preserved and the helper accepts no callback, model, network or mutable
history input. The helper always registers the complete shared descriptor; its manifest and
registration must match. Other heterogeneous service contracts may still omit optional metadata.


`provideContextBudget(context, { identity, configuration, decide })` registers the metadata-only
`varin.context.budget@1` Decision. Declare `VARIN_CONTEXT_BUDGET_SERVICE` in the package manifest. Inputs
and configuration are detached and recursively frozen; cancellation discards unfinished output. Choose
only a supplied `throughId` and return explicit background/blocking mode, optionally adding summary
instructions. Core rejects a new background Decision when `settings.backgroundPreparation` is false.
Do not perform retrieval, model requests or tools inside this callback. The native default
remains selected until the user explicitly routes this service; summary generation and recovery remain
owned by the original runtime.
