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
and `varin.builtin.ide-workbench.shell` on web and desktop only. Selecting a profile does not
enable or disable extensions.

Shell contributions declare which replacement targets and slots they actually host per surface
using the `varin-workbench-shell/v1` contract in `data`. The parser
`parseVarinWorkbenchShellContributionData` validates that every supported surface has a seam
entry, that no unsupported surface is declared, that targets and slots are unique, and that
`workbench.shell` and `workbench.transition` never appear as nested targets. Use
`resolveVarinWorkbenchShellSurfaceSeams` to read the seams for a specific surface.

Replaceable Motion and cross-Shell handoff are specified in
[`docs/design/varin-motion-platform.md`](../../docs/design/varin-motion-platform.md). The contract describes
transition lifecycles and owner identity; it does not prescribe which elements a Shell must render.
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

`VARIN_RETRIEVAL_PLAN_CONTRACT` describes the declarative `varin.retrieval.plan@1` boundary.
`describe([])` returns an immutable `configurationId`, `structure: 'builtin' | 'disabled'`, and optional
`semantic: 'builtin' | 'disabled'` (omission disables semantic recall). The parser rejects unknown
fields, including model selectors. The selected native Host owns keyword/structure implementations,
the semantic backend/published-reader lease, and all Run-granted reads; the extension gets no query,
source text, root, filesystem or model capability through this contract.

A service provision may carry a single `tool` declaration: name, description, input/output JSON
Schema, `completion: result | job`, and `operation: read | effect`, with optional examples and source
location. Independent Job declarations require an explicit `lifetime: thread | environment`; Result
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
does not. Original routing rules keep `providerKey`, or explicitly choose ordered `providerKeys`.
The fields are mutually exclusive, repeated keys reject, and an empty list means no contribution.
Every selected member is required; fallback, if enabled, chooses an entire lower-priority rule and
never shortens a partially available collection. Equally ranked different orders conflict.
Single-service invocation rejects any collection rule, including a one-member list. User single-value
configuration and external extension assets are not rewritten. The routing document remains the same
owner/schema with the additive rule shape, and inspection reports collection order separately.


`VARIN_CONTEXT_BUDGET_SERVICE` is the shared manifest/registration/method-schema declaration for
`varin.context.budget@1`. `VARIN_CONTEXT_BUDGET_CONTRACT` describes its `before_model_dispatch` Decision:
`describe` fixes identity/configuration and `decide` receives estimates, settings and native legal
ancestor metadata. It returns `continue` or `compact` with a candidate `throughId`, explicit
background/blocking mode and optional summary guidance. No history bodies, credentials, tools, private
policy state or model access are supplied. Core validates ancestry and preserves its summary safety
instructions, real inference usage and atomic checkpoint publication.
