# @varin/extension-sdk

Framework-neutral authoring API for managed, isolated, and brokered-Host Varin extensions.
Extensions export an `activate` function or use `defineSurfaceExtension`, `defineIsolatedExtension`,
or `defineHostExtension`. Activation contexts own contributions, services, disposers, authenticated
assets, styles, revisioned storage, and capability clients without importing Varin's product UI.

Every service requirement declares `realms: ['host']`, `['surface']`, or both. Required dependencies
are resolved before that realm activates. Host `context.services.use(id, version)` captures one exact
client; `useAll(id, version)` captures a declared collection. Surface `useService`/`useServices` use the
same frozen-choice rule. Selection comes from the original scoped routing configuration, never a
second global selector. An exact provider option can choose a member of the already bound collection;
it cannot introduce another implementation. Captured handles keep their original generation while
calls drain. Call-specific authority and cancellation still come from the current invocation, not
from the shared activation context.

Managed Surface extensions write custom context keys with `context.context.set(localKey, value)` and
`delete(localKey)`. Varin prefixes the extension ID, stages candidate values until activation commits,
and returns `false` to a disposed or superseded writer. Isolated extensions receive the same owner-scoped
client through their message bridge; its `set` and `delete` methods return promises.

Host extensions open independent namespaced documents with
`await context.storage.open({ scope, key, schemaVersion? })`. Each document client exposes its own
snapshot, refresh, revision-checked update, and schema version. Varin injects the extension ID, so
an extension cannot address another extension's namespace. `context.storage.snapshot/update` remains
the compatibility client for `application/state`; new code should use `storage.open(...)` explicitly. Scope names are
namespace labels, not automatic per-user/project/session partitioning. Put an explicit stable entity identity
in the key when a shared provider needs separate documents; they are not authorization boundaries.
The manifest-driven `migrate` callback applies to that compatibility document only. For other documents,
`open({ schemaVersion })` selects the version for later writes, not a data conversion. Inspect the
returned snapshot, explicitly transform older data, and commit with its revision. Activation-time
writes are staged with the candidate; active writes use the original storage CAS.

`defineSurfaceMount` creates a framework-neutral contribution implementation. Its `mount(container,
context)` callback receives an ordinary `HTMLElement`, contribution props, owner metadata, a
mount-scoped `AbortSignal`, and `reportError`; it may return a synchronous or asynchronous disposer.
Varin aborts and disposes that mounted instance when its props or owner change, the extension is
disabled, or the host unmounts it. DOM, Canvas, Web Components, and framework-owned roots can all use
the same contract without importing Varin's React or private UI.

`defineSettingsPageMount` connects an ordinary mount to Settings using public literal-title metadata;
`defineCommand` provides a palette command without private translation keys. `defineMessageRenderer`,
`defineToolRenderer`, and `defineSessionDecoration` combine a presentation-only `matches` predicate
with the same mount contract. They receive detached read-only JSON snapshots. Use the exported
`VARIN_CONVERSATION_SLOTS` for actual conversation host points. These callable contracts are for
managed/native code, not functions transferred through an isolated MessagePort. A descriptor alone
is discovery metadata, not a mounted view or permission to perform work.

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
shows independent output and the original Run/Wait resume boundary. Installing these examples does
not select their policy or give it ownership of core history.

`provideRetrievalPlan` and `varin.retrieval.plan@1` are deprecated compatibility exports.
The current native retrieval Agent does not consume staged keyword/structure/semantic plans.
Existing custom service consumers may still use the wire contract; registering it does not change
`code_retrieval`. Use the ordinary tool, policy and context contracts for current Agent behavior.
See the [authoring guide](../../docs/ops/varin-extension-authoring.md#native-retrieval-plans).

`provideTool(context, declaration, execute)` registers an ordinary Host service with `inspect` and
`execute` methods. Import the service descriptor directly from the package's `varin.extension.json`
so cold discovery and activation use one declaration. `execute(input, call)` receives normal JSON,
cooperative cancellation and `call.capabilities`, a client bound to that invocation. Schema compilation
and admission remain with the executing Host; the SDK never owns history, Operations or resource facts.
Return the tool's JSON data directly. Null and empty results are valid; missing/non-JSON results fail.
For Result callbacks, use `await call.output({ kind: 'text', text })` or
`await call.output({ kind: 'media', media: { media_type, data_base64 } })` for explicit ordered
presentation parts. `call.output`, like `call.tools`, requires the reviewed Host `runtime.tools`
capability and a live invocation. The original completion retains one `{ data, parts }` body; a returned
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

`provideContextCompaction(context, { identity, configuration, prepare })` registers the pure
`varin.context.compaction@1` Provider with `VARIN_CONTEXT_COMPACTION_SERVICE`. It receives detached,
recursively frozen source quotations and returns direct text or a complete model plan. The SDK checks
the exact cut and references before returning. Preparation must not call models, tools or external
services; model nodes request normal core-owned execution. A single actual pin covers describe,
prepare and native admission. Accepted plans belong to the original ContextJob and survive provider
replacement/unload without calling it again on recovery. See the [independent source merge-tree
example](../../examples/extensions/context-compaction/README.md).
The preparation input contains only frozen quotations, their cut hash and `modelBudget`, alongside
this Provider's own frozen algorithm configuration. The cut binds those source/budget facts.
A model plan's full model configuration and credential scope are frozen separately by native
create/Launch. Direct text does not resolve model credentials or model-configuration routing, including
its first admission; compaction service selection remains on the original scoped service router.

`provideModels(context, { description, protocol?, authenticate? })` registers `varin.models@1` using
`VARIN_MODELS_SERVICE`. The description contributes typed channels, read-only model candidates,
OAuth methods and actual protocol implementations. Model candidates do not silently become saved
channels or enabled selections. One selected provider is unambiguous; multiple providers use the
existing explicit ordered service routing.

A protocol callback receives generated `ModelProtocolCall` values and returns `ModelProtocolResult`.
These types come from the private Rust protocol schema, including original request/run identity,
semantic history, complete items and usage. The SDK freezes detached inputs. Rust owns HTTP, SSE
framing, original Operations, durable request bytes, cancellation and recovery. No codec callback may
start a second model request or retry an uncertain dispatch. The current brokered protocol contract
supports chat over SSE; other operations require their actual existing native implementations.
Custom API keys require an explicit channel `credentialHeader`; credentials never enter codec input.

OAuth callbacks require the reviewed `varin.models.authentication` capability before the Host sends
any account token. `begin` returns an authorization URL plus transient state; `complete` consumes the
workbench reply; `refresh` preserves the same account. Its call-scoped client can POST form/JSON fields
only to the provider's declared exact HTTPS token endpoints. The existing credential store owns
persistence and single-flight refresh. Ordinary replacement preserves captured refresh implementations;
canceling a waiter does not release their real callback. See the [custom text/SSE codec
example](../../examples/extensions/model-protocol/README.md).

## Replaceable Run drivers

`provideAgentDriver(context, implementation)` registers `varin.agent.driver@1`, an actual
execution algorithm independent of the default loop and `policy@4`. Declare
`VARIN_AGENT_DRIVER_SERVICE` and the Host capability `VARIN_AGENT_DRIVER_CAPABILITY`
(`runtime.driver`) in the manifest. Identity, configuration, model roles and recovery support
are captured by `describe`; installation alone does not select the driver.

`run(input, context, configuration)` receives detached, recursively frozen native Run input.
Use `context.driver.model`, `tool`, `context`, `wait`, `cancel`, `checkpoint`, `deliver` and `receipt`; their DTOs are
generated from the native protocol, not a second SDK wire schema. Calls can overlap and model
requests carry independent `ModelConversationItem[]` histories. `capabilityId: null` uses the
original primary model; the currently supported additional role is `agentPlanning`. All
credentials, admitted tool schemas, permissions, resources and execution receipts stay with
their original owners. Stable work IDs identify original work; after an uncertain response,
inspect its receipt rather than dispatching new work under another ID.

`context.driver.context()` consumes currently available input from the original Run Inbox and
returns freshly compiled history, the current admitted `tools` cut, consumed
`inputIds` and `activating`. Choose your own refresh
or re-planning points; it is not a blocking wait, polling scheduler or second input queue.
Use `context.driver.wait({ after: null, work: [] })` to read the original Run event baseline,
then pass its `cursor` as `after` to await activity in the original Run without polling.
`work` contains known original model/tool/delivery identities; unknown work is rejected.
It selects which receipt snapshots to return, not which events may wake the call. Even `work: []`
may wake on that Run's own delivery or other activity. If the desired condition is not yet true,
wait again with the returned cursor; this is an event-driven wait, not a sleep/poll loop.
`inputPending` does not consume input: call `context()` when the algorithm chooses to replan.
`context.driver.cancel({ kind: 'model' | 'tool', id })` targets work admitted by this original
instance. Its `requested` flag is cancellation intent; the accompanying receipt may still show
running/unknown work. Neither cancel nor a rejected observation proves an executor has stopped.

A tool's `job_accepted` receipt is its original acceptance, not a terminal success. Observe its
original identity with `wait`/`receipt`, then read results through that domain's admitted tools
(for example `question_status`, `process_read` or `retrieval_control`) or refresh original history
with `context()`. There is no invented universal result tool. A driver can remain active while an
`ask_user` question awaits its authenticated answer; this does not grant any tool permissions.
Complete only after answering or explicitly cancelling your pending questions.

The helper uses the **service call's** capability client, never an activation-global client or
a mutable `currentRun`. Run/epoch fields in the observation are not authority; the Host binds
an opaque original instance that SDK authors cannot supply. Retaining the client after return
does not retain its authority. Cancellation blocks new calls but does not erase a receipt from
already-dispatched work. Algorithm return is not proof that those executors stopped.

Declare `recovery: 'none', checkpointSchema: null` when restart is unsupported. Checkpoint
drivers require an exact schema and a separate `resume` callback; the SDK rejects missing or
mismatched recovery instead of calling `run` again. Current selection changes do not rebind old
Runs. Trusted Host code is not an OS sandbox, and a driver capability grant is not unrestricted
tool approval. See the [parallel driver](../../examples/extensions/parallel-driver/README.md)
for an executable multi-branch author example.

### Atomic driver completion

Before returning `complete` or `fail`, call `context.driver.finish({ outcome })` while the original
callback is still live. `committed` is the original Catalog terminal transaction, not a preflight.
`input_pending` and `work_pending` leave the same callback able to consume `context()` or await
`wait()` and choose its next action. Authors must first join the primitive promises they launched;
`work_pending` does not mean any next event proves settlement, especially for unknown external effects.
When waiting on durable work, read the original baseline before the finish attempt so events cannot
be lost between refusal and subscription. A final context refresh alone cannot prevent new input from
arriving afterward. The SDK never reruns the algorithm automatically to hide this conflict.

After `committed`, no new primitive calls are admitted. Return from the callback to let its actual
work drain; logical completion does not authorize early release of the original callback, provider,
credentials or tool owners. A later callback error cannot rewrite the committed execution result.


## Scoped Host credentials

`credentials(call.capabilities, connectionId, expectedAccount?)` accesses the Host's existing
credential lifecycle through `varin.credentials`. `credentialNamespace(call.capabilities)` supplies
a stable plugin-specific user key for nonsecret plugin storage documents. Use `inspect` for nonsecret connection metadata,
`put` for API keys, and `start/read/reply/cancel` with a same-owner `authenticate` Host service for
OAuth. Every adapter `authenticate` handler must first await
`assertCredentialAuthentication(call.capabilities)`, before reading configuration or returning state.
This requires the Host credential owner’s exact retained callback scope: ordinary service or Surface
RPC must not expose PKCE state or tokens. Preserve `inspect().account` with a chosen connection and pass it as `expectedAccount` so
reconnection cannot silently replace an accepted selection. `resolve` is Host-only: never return
its secret to the renderer, a tool result or model context. The Host supplies authenticated identity;
JSON user IDs and activation-time clients cannot select another user's credentials.
See the [author guide](../../docs/ops/varin-extension-authoring.md#host-credentials-for-connected-services)
for adapter responsibilities and deployment boundaries.

## Durable inbound event sources

A service event becomes a durable source only when its existing `contract.events[name]` declares
`durable`. Declare `sourceId` (unique within the extension), `displayName`, `connectionsMethod`,
`receiveMethod`, `modes` (`push`, `stream`, `poll`), `recovery` (`history` or `realtime`),
`credentials` (`required` or `none`), and `filterSchema`. Both named methods belong to the same
service declaration and implementation. The event's `schema` validates its structured `attributes`;
filters are validated against `filterSchema` and matched by Catalog as an exact attribute subset.
Use the same descriptor at manifest and activation time. Ordinary notification events without
`durable` never trigger model work.

Request the `varin.events` Host capability, plus `varin.credentials` for authenticated sources.
The connections method receives `{ sourceId }` and returns `VarinEventConnection[]` with connection
IDs and display names, never tokens. Host replaces `accountId` with the actual saved credential
`account` identity for credential-backed connections. A credential-free source must provide its own
stable nonsecret configuration identity. Discovery may inspect metadata and obtain its plugin
namespace, but cannot resolve or change credentials as a side effect.

The Host calls the receive method with `VarinEventReceiveRequest`: the original source, connection,
selected account and saved cursor. This is a long-lived, cancellable service invocation, independent
of any Bot Run or window. Use `credentials(call.capabilities, request.connectionId, request.accountId)`
for this exact connection; the receiver cannot replace credentials or read another account.
Use `eventReceiver(call.capabilities)` to assert receiver authority and submit `VarinEventBatch`.
Do not use activation-time capabilities. Clean up remote subscriptions and network waits in `finally`
when `call.signal` is aborted, and return only when the real receiver has stopped.

`submit` returns the committed cursor and accepted/duplicate counts only after Catalog acceptance.
Await it before acknowledging a provider callback or advancing a local sync cursor. Failure or a
lost response does not mean rejection: retain the same stable event IDs and revision, and resume from
the Catalog cursor supplied on reconnection. `occurredAtMs` is the actual UTC millisecond timestamp
of this event or revision, not the time it was synced or received. Backfill preserves that original
time so an explicit discard-and-continue boundary does not reintroduce old events. If the provider
cannot supply it, disclose that limitation rather than inventing the current time. Empty incremental results may advance a provider cursor
without creating model work. The plugin chooses a provider-appropriate polling cadence and retries;
the Host retries unavailable receiver startup, not individual network requests on the plugin's behalf.

For a complete, replaceable state snapshot only, set `state: { key, sequence, value }`.
`key` identifies a state stream within the same source/account, object and sender; `sequence` is
the source's non-negative safe integer ordering, preserved on backfill; `value` names the current state.
At a receiving boundary Varin expands the latest snapshot and retains changes in `value` (for example,
failed → healthy). Equal sequences with distinct events retain their bodies rather than guessing order.
Omit `state` for ordinary messages, comments, requests or independent facts that must each be processed.
Split those facts from a replaceable snapshot when necessary. Original events and files remain readable
through the arrangement occurrence after delivery; coalescing never edits an already supplied model request.
Overlapping arrangements share event bodies within the same delivery while keeping all their intentions,
filters and receipts. Native and remote Hosts carry the same state declaration without regenerating it.

Submit text and inline media bytes in the existing `OutputBody<IncomingMedia>` shape. Submit arbitrary
original files separately as `files: [{ fileId, filename, mimeType, bytesBase64 }]`. This typed boundary
supports PDF, CSV, ZIP and empty files; it does not treat file bytes as media or ordinary JSON data.
File IDs are unique within the stable event. Catalog saves the bytes in ContentStore, assigns immutable
attachment identity and publishes original target delivery facts. Arbitrary attachment/storage
references are not accepted, and retrying an existing event with changed file bytes is a conflict. `coverage` reports actual complete history or the earliest covered time; realtime-only
restarts are exposed as partial coverage, never assumed to include the offline interval. The optional
`echoOf` includes the original follow-up, occurrence and successful operation identity. Include
`ownerHostId` when the original operation belongs to another Host. The authenticated transport preserves
this scope, and only the executing Host checks its own original receipt and consumed source object.
Catalog, not plugin assertion alone, determines whether it is a confirmed echo.

The adapter owns provider callback authentication, parsing, remote registration/revocation and its
actual network ingress or relay. A `push` declaration does not create a public callback URL or deploy
a relay. `poll` and `stream` work without a public endpoint. No provider-specific Gmail/GitHub adapter
is bundled by this contract.

A saved arrangement can select a source on a configured managed Host. The platform owns authenticated
ledger paging, destination admission before source acknowledgement, consumer generation fencing and
release. Plugins still connect only to their local account; they do not forward events to arbitrary
URLs or retain a second destination queue. New remote consumers expose their actual coverage start,
while existing consumers preserve unacknowledged events across disconnect and restart.
