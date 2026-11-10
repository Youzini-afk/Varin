# @varin/extension-contract

Browser-safe, versioned data contracts shared by Varin application hosts and surfaces.

This package describes Varin extensions. It does not describe or load Pi packages, and it does
not contain an extension runtime. Extension packages publish a standalone
`varin.extension.json`; npm, Git, local-directory, and built-in sources all resolve to that same
manifest contract.

The same contract validates selected and staged candidate artifacts, selected/candidate capability
decisions, a separate persistent candidate-application request, content-addressed asset and
managed-entrypoint payloads, revision-checked candidate selection, and per-realm actual state. Public
catalog DTOs expose source identity and integrity without exposing source specifiers or host paths.

Multi-provider Host services expose a stable `providerKey` separately from their generation-bound
`providerId`. Revisioned routing rules can select a provider from distribution through invocation
scope; the application host performs resolution and reports ambiguity or unavailable selections
without teaching a renderer to merge policy.

The package publishes editor schemas at `@varin/extension-contract/schema/manifest` and
`@varin/extension-contract/schema/discovery`. Discovery documents contain ordinary npm, Git, local,
or built-in source specifiers and remain optional installation shortcuts rather than an allowlist.

Stable workbench replacement targets and contribution slots, including `view` and `editor` kinds,
live in this package. Application surfaces import those constants; they must not keep a second
string table. The distribution Agent profile keeps the stable ID `default` and the English fallback
label `Agent`; official UI localizes that name. Its default `workbench.shell` contribution is
`varin.builtin.agent-workspace.shell`. The optional IDE profile uses the stable ID `varin.ide`
and `varin.builtin.ide-workbench.shell` on web and desktop only. Applying a profile extension set is separate from selection. The explicit enable-and-switch
mode path may enable its selected shell, with rollback if the profile commit fails.

Shell contributions declare which replacement targets and slots they actually host per surface
using the `varin-workbench-shell/v1` contract in `data`. The parser
`parseVarinWorkbenchShellContributionData` validates that every supported surface has a seam
entry, that no unsupported surface is declared, that targets and slots are unique, and that
`workbench.shell` and `workbench.transition` never appear as nested targets. Use
`resolveVarinWorkbenchShellSurfaceSeams` to read the seams for a specific surface.

Command contributions may opt into the conversation menu with validated `composer` metadata:
`name`, a supported `group`, and `interaction: 'action' | 'select'`. Registration alone does not
add a global command to that menu. Extensions retain their contribution identity and activation
path; name collisions use a distinct extension invocation. The public execution context carries
the selected Host generation and optional native Thread/branch/Source DTO, never native composer
action closures. Both availability checks and execution receive that same public context, and
Host replacement fences activation before execution.

Current transition lifecycle and owner boundaries are described in
[the workbench contract](../../docs/workbench.md). The generic Motion/shared-element service is not implemented.
The contract does not prescribe which elements a Shell must render.
`transition-scene` contributions replace `workbench.transition`; the default cube scene is an
ordinary enabled-by-default built-in contribution rather than a Core rendering requirement.

Core workbench services use versioned IDs `varin.workspace.search` and `varin.language`.
Those IDs identify Host services; they are not a second plugin manager.

The public `VarinEditorDocumentController` is framework-neutral. Its offset-based `applyEdits`
uses zero-based UTF-16 offsets and distinguishes `applied`, `stale`, `conflict`, `invalid-range`,
`overlapping-ranges`, and `unsupported`; `replaceContent` remains a convenience operation with the
same version/conflict boundary. The optional Surface-local Monaco service uses
`VARIN_EDITOR_MONACO_SERVICE_ID` (`varin.editor.monaco`) and version `1`. It exposes only
serializable view snapshots, ranges, actions, and declarative decorations—never a Monaco editor,
model, DOM node, or `RuntimeAPIs` capability.

Contributions may declare a structured `when` expression (`VarinContextExpressionV1`) that
controls visibility based on workbench context keys. The expression supports `defined`, `equals`,
`not`, `all`, and `any` operators. The parser `parseVarinContextExpression` and evaluator
`evaluateVarinContextExpression` are exported from this package. `when` is not allowed on `shell`
or `transition-scene` contributions — context changes on those kinds would bypass Workbench Profile
stage-and-commit and Recovery invariants.

Contribution compatibility is checked before kind-specific data validation. A contribution with an
unknown `contractVersion` is still parsed (structure, id, kind, supports) but its data payload is
not validated. Use `checkVarinContributionCompatibility` and `isVarinContributionCompatible`
to determine whether a contribution is executable on the current runtime.

See the complete [authoring guide](https://github.com/Youzini-afk/Varin/blob/main/docs/ops/varin-extension-authoring.md).

`VARIN_AGENT_POLICY_CONTRACT` describes the `varin.agent.policy@4` Decision boundary, its explicit
state-only `transitionState` method and required `modelRoles`/`stateTransition` description, including
inspectable input/output schemas. `parseVarinAgentPolicyInput` and `parseVarinAgentPolicyDecision`
validate detached run/event facts, finite actions and private JSON state. The view deliberately
contains history count/head references and settlement metadata, not full histories or tool bodies.
The native core remains the authority for legal action admission and durable checkpoints.
`tool_graph` nodes use the same trusted tool contracts as model calls. Each `tool_graph_completed`
node carries exactly one tagged completion: `not_dispatched`, `result` (outcome, effect, required
scoped output reference), or `job_accepted` (operation ID, phase, effect, lifetime, and an optional
scoped acceptance-output reference). Job acceptance does not assert a terminal job outcome. Even a
JSON-null result has a committed content reference; a retained JSON-null acceptance also stays null.
`read_result` retains its original scoped reference and chunk cursor. Each chunk declares
`format: 'output_body' | 'model_evidence'`: the former contains the resolved `{ data, parts }`
output body, while the latter retains explicitly labelled auxiliary-model evidence. `deliver`
accepts `output: OutputBody<IncomingMedia>` rather than an untyped text field. Its ingress cannot
supply storage references or source identity. Older internal policy contracts are rejected rather
than translated.

`VARIN_RETRIEVAL_PLAN_CONTRACT` retains the deprecated `varin.retrieval.plan@1` wire contract
for existing SDK packages and custom consumers. The current native retrieval Agent does not consume
it; it does not grant file/model access or select native keyword/structure/semantic stages.

A service provision may carry a single `tool` declaration: name, description, input/output JSON
Schema, `completion: result | job`, and `operation: read | effect`, with optional examples and source
location. Optional `requirements` declare a source dependency (`source`, `physical`, or `live`) and
`process: boolean`; they do not grant access. Optional `disclosure` retains a summary, aliases, namespace
and operation paths into the original input schema's `oneOf`/`anyOf` branches, not a replacement schema. Independent Job declarations require an explicit `lifetime: thread | environment`; Result
declarations omit lifetime. A trusted domain adapter must durably accept the original operation before
the extension can return that Job reference. A declaration or returned JSON alone cannot bind a domain
subject or prove executor stop. Its service ID/version remain the stable contract identity. Manifest parsing preserves and
validates this metadata; the executing Host compiles schemas before admitting calls. The declaration
is inspectable metadata and never permission, trusted replay evidence, or a resource/execution receipt.

Tool and method/event source declarations share one package-relative path and positive safe-integer
line contract. Absolute paths, URLs, traversal, empty segments and unknown source fields fail manifest
admission. Omitting source remains valid; inspection preserves declared source metadata unchanged.

Runtime discovery separates current-catalog metadata, an accepted Run's frozen tools, and explicit
immutable package source reads. A `queryContracts` source request uses
`{ action: 'read', kind: 'source', extensionId, slot, artifactIntegrity, path, offset?, maxBytes? }`.
Use the artifact reference from the service implementation and its declared package-relative source
path. `slot` is `selected` or `candidate`; an artifact integrity is a content address, not a semantic
version. A candidate reference does not change which descriptor the metadata describes. The shared
request declaration generates the tool schema and input decoder; public API and ordinary
`runtime_contract` consumers use the same result decoder.

Successful source results expose the artifact/file integrities and a UTF-8 byte page with exact
offset, byte length, total bytes and nullable continuation. A page never splits a code point. Code
is returned as data, not evaluated. This API does not grant arbitrary Host filesystem access or
activate an unprepared package; unavailable, stale, missing, invalid and corrupt results retain their
distinct codes. It does not promise source access to retired accepted-Run bindings after their
catalog slot has changed.

`VarinExtensionPackageRequest` declares the ordinary `extension_package` actions: `stage` captures a
source-relative package directory (including `.`), and `apply` names an exact reviewed candidate.
Only `stage` requires a SourceView. `VarinExtensionPackageResult` distinguishes disabled first
installation, staged update, committed application request and selected artifact. Execution/mount
status remains with the original realm owners. `source_view` is trusted capture provenance in the
catalog, never an installable discovery source or a client-supplied filesystem resolver.

A manifest may opt one extension into an explicit candidate update group with
`updateReadiness: { surfaceEntrypoints: ["panel"] }`. The group contains that extension's Host
and the named Surface entrypoints in one participating compatible realm. Merely shipping a UI
entrypoint creates no dependency. This is an update publication requirement, not a permanent
window dependency: initial enabled startup and recovery of an already selected artifact use their
ordinary Host lifecycle. Other extensions and other windows do not join the group implicitly.

Only `VarinExtensionCandidatePublicationRequest` carries `surfaceReadiness`. Application-request
and discard requests reject that field. The evidence names the original Host preparation identity
(including its per-instance ID), realm, Surface kind, and exact prepared local member generations.
It is a trusted Surface-host transaction report, not a credential, durable window registry, or
proof that an entire screen is visible. Connected contribution consumers must finish their real
mount preparation before the report; entrypoint activation without a mounted consumer proves only
entrypoint readiness. Exact provider handles retain the existing generation handshake.


Context fragments retain the author `describe` v1 declaration. `ServiceProvision.contract.composition:
"ordered"` explicitly opts a provider into that contract's collection consumer; `multiple` alone
does not. Routing rules use only `providerKeys: string[]`; each provider's stable identity remains
`providerKey`. Repeated keys reject. Single-service invocation requires exactly one key. An ordered
consumer accepts an ordered list, including an explicit empty list that means no contribution.
Every selected member must support the ordered contract and is required; fallback, if enabled,
chooses an entire lower-priority rule and never shortens a partially available collection. Equally
ranked different orders conflict. Removing a scope rule restores inheritance. Inspection returns
`providerKeys` and, when registered, the matching generation-bound `providerIds` in the same order.
The routing document and its actual storage schema marker remain the authority; malformed or stale
state cannot become successful automatic routing.


`VARIN_CONTEXT_BUDGET_SERVICE` is the shared manifest/registration/method-schema declaration for
`varin.context.budget@1`. `VARIN_CONTEXT_BUDGET_CONTRACT` describes its `before_model_dispatch` Decision:
`describe` fixes identity/configuration and `decide` receives estimates, settings and native legal
ancestor metadata. It returns `continue` or `compact` with a candidate `throughId`, explicit
background/blocking mode and optional summary guidance. No history bodies, credentials, tools, private
policy state or model access are supplied. Core validates ancestry and preserves its summary safety
instructions, real inference usage and atomic checkpoint publication.

`VARIN_CONTEXT_COMPACTION_SERVICE` declares `varin.context.compaction@1`, a pure Provider separate
from the budget Decision. `describe` fixes identity/configuration; `prepare` receives addressable,
unbudgeted, opaque-free source quotations and model budget facts. It returns direct text or a complete
topologically ordered model plan. Source ranges use UTF-8 byte offsets; media references are whole.
The parser rejects stale cuts, unknown/forward references, split code points and unused model nodes.
Core executes normal serial ModelSteps, retains original usage and commits the final candidate through
the original ContextJob. The Provider has no model/tool/history-write capability through this API.
The source-cut hash binds those exact quotations and `modelBudget`, not a model credential grant.
The native create/Launch boundary separately fixes the full model configuration and credential scope
for a `model_plan`. A direct `text` candidate needs no model credential/configuration resolution on
initial admission or recovery; selecting the compaction Provider still uses ordinary service routing.

`varin.agent.driver@1` is an execution consumer, distinct from the default loop's `policy@4`.
`agent-driver.ts` owns its description, capability constant and scoped selection semantics;
`run-driver.generated.ts` supplies primitive/input/receipt DTOs from the native protocol.
The public envelope parsers do not duplicate native nested wire validation. Description fixes
implementation identity, JSON configuration, prepared model roles and explicit checkpoint
recovery/schema. A returned algorithm outcome is not an assertion of actual executor stop.
The same call-scoped capability includes non-blocking `context` (consume the original Inbox
and return compiled history plus the currently admitted tool cut), `wait` (observe original Run
events and known work without consuming input), and `cancel` (request stop for an original
instance's model/tool ID).
Neither introduces another input queue; cancellation intent and actual work receipts stay distinct.

`resolveVarinAgentDriverRouting` uses the existing routing document and precedence. No explicit
choice selects the native default, not the only installed extension. The reserved choice
`varin.builtin.agent-driver` lets a workspace explicitly override an inherited extension with
the native driver; it is not a fake Host service registration. Removing the scope rule restores
inheritance. Unavailable, empty, conflicting or unsupported-version explicit choices remain
unavailable; legacy `allowFallback` does not authorize silently switching a Run's algorithm.

`releases.ts` defines the shared `varin.release.json` manifest, redacted installation preview,
Host-bound confirmation, update-check result and canonical logical-source identity. GitHub release and
local archive sources persist beside existing local/Git/npm sources. Discovery adds optional author,
repository, categories and content version; an individual catalog still has unique extension IDs,
while different catalogs may present separately identified sources for the same extension ID.


`credentials.ts` defines the `varin.credentials` Host capability and a small authentication callback
contract (`begin`, `complete`, `refresh`). It has no plugin account/provider registry: plugins own
connection configuration and provider-specific exchanges. Credential metadata and authorization state
are safe presentation values; credential values are confined to trusted Host adapters.

Tool declarations may opt into typed model references with `references.inputs` and
`references.outputs`. Each entry selects an explicit JSON pointer `path` (array `*`
segments only), a `kind`, an extension-local resource `owner`, the `reference`
property, and exact target `fields`. Output `omit` defaults to those fields. The
Host registers the original target in the native Catalog, projects only declared
positions, and resolves/fixes the input before confirmation and execution. Opaque
third-party IDs and ordinary strings are never scanned. The declaration is part of
the pinned service generation; original tool arguments and raw UI receipts remain
unchanged. A reference does not grant access or bypass the resource owner's checks.

For an accepted Job, an owner-authored model projection may publish `operationRef`
as its canonical typed operation handle. Transient provider input uses that exact
field for the Job header; a projection without it retains the original handle.
This reserved field is not inferred from ordinary extension output or ID-like JSON.
Typed attachment `modelRef` likewise changes only the transient descriptor's `ref`;
raw receipts retain the original immutable attachment reference.
