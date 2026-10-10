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

`VARIN_AGENT_POLICY_CONTRACT` describes the `varin.agent.policy@2` Decision boundary, including
inspectable input/output schemas. `parseVarinAgentPolicyInput` and `parseVarinAgentPolicyDecision`
validate detached run/event facts, finite actions and private JSON state. The view deliberately
contains history count/head references and settlement metadata, not full histories or tool bodies.
The native core remains the authority for legal action admission and durable checkpoints.
`tool_graph` nodes use the same trusted tool contracts as model calls. Each `tool_graph_completed`
node carries exactly one tagged completion: `not_dispatched`, `result` (outcome, effect, required
scoped output reference), or `job_accepted` (operation ID, phase, effect, lifetime). Job acceptance
does not assert a terminal job outcome. Even a JSON-null result has a committed content reference.
Version 1 graph actions and receipt shapes are not accepted by version 2.

`VARIN_RETRIEVAL_PLAN_CONTRACT` describes the declarative `varin.retrieval.plan@1` boundary.
`describe([])` returns an immutable `configurationId`, `structure: 'builtin' | 'disabled'`, and optional
`semantic: 'builtin' | 'disabled'` (omission disables semantic recall). The parser rejects unknown
fields, including model selectors. The selected native Host owns keyword/structure implementations,
the semantic backend/published-reader lease, and all Run-granted reads; the extension gets no query,
source text, root, filesystem or model capability through this contract.
