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

`provideAgentPolicy` implements `varin.agent.policy@1` at committed execution boundaries. Its
immutable declared configuration and versioned private JSON state are distinct from core history;
the Host pins exact package/configuration identity for the Run. Return a permitted action rather
than calling models or tools in the decision handler. Core validates exchanges, permissions,
registered waits and cancellation. [The bounded evidence example](../../examples/extensions/evidence-policy/README.md)
shows the executable contract and current action limits.

`provideRetrievalPlan(context, { configurationId, structure })` registers an immutable
`varin.retrieval.plan@1` declaration with matching `inspect` schemas. Select `structure: 'builtin'`
for the existing native structure stage or `'disabled'` for keyword-only retrieval. Do not perform
filesystem, model, index or other external work during declaration. The Host supplies stages and
keeps a generation pin for each native query; ordinary extension replacement preserves existing
queries, while explicit disable/crash revokes their bindings. See the
[authoring guide](../../docs/ops/varin-extension-authoring.md#native-retrieval-plans) for routing.
