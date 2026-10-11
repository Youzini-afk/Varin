# Reviewed native MCP sampling

Date: 2026-10-11 (UTC). Baseline: `7018724daf012e20d897b83082e98025ed2aad4c`.
Status: finite implementation and independent behavior review accepted. Product/platform acceptance
and the remaining two-design capabilities are separate below.

## Finite capability and original owners

The original MCP authority advertises basic `sampling` only when its receiver is installed before
initialize. A real HTTP response stream or accepted Task supplies the originating Operation, client,
endpoint and permission holder. A known related Task takes precedence over the stream. Unknown
Tasks and ordinary unassociated stdio cannot infer a current Thread. There is no parallel client,
permission list or model catalog.

The first public review edits the complete remote request and explicitly selects a model through
the existing Host model authority. The renderer supplies neither configuration endpoints nor secrets.
The original model registry, adapter, serializer, private credential bridge and provider transport
execute a real generation Operation in the existing Catalog and RunSupervisor. A second review
accepts or rejects the actual output before responding to that original server. Generation success
cannot silently answer the MCP request, resume its parent Run or add a main-conversation message.

Reviewed systemPrompt/user/assistant roles retain their meaning inside the isolated request, with
sampling provenance. No main history, tools, memory, opaque continuation or Goal instruction text is
imported. The original tool origin's frozen Goal identity still controls budget admission and usage;
content isolation does not detach execution from its user's Goal. Task-owned generation can outlive
natural parent Run completion through an explicit operation-scoped credential lifetime. Scope/account
withdrawal, original source/Goal cancellation, Task terminal state and kernel close remain fences.

This slice accepts text/image blocks or block arrays and produces text. Tools/toolChoice, audio,
context inclusion, reverse task augmentation and unsupported provider metadata have actionable
unsupported diagnostics. Original `_meta` Task association is not task augmentation. Model hints do
not replace explicit selection. The original request and actual model capacity bound maxTokens;
unsupported stop-sequence or output-cap mappings fail before provider dispatch. A universal Stop
receipt does not identify the more specific MCP stop reason, so no unsupported reason is inferred.

The [fixed MCP sampling specification](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)
owns the external protocol. This record does not claim every optional sampling feature is implemented.

## Durable facts, control and public consumption

Catalog **54** and private wire **9** directly reject obsolete internal formats. The original
interaction owns review and delivery; its linked generation Operation owns dispatch, cancellation,
model execution and usage. Complete original/edited requests, provider snapshot, observed output,
receipt and candidate response live in the existing ContentStore. Publication protection spans body
writes and metadata commit; GC follows original Operation and interaction roots, including previous
failed attempts. No second execution ledger, result store or recovery backend is added.

Pages and lifecycle sweeps expose short projections. Explicit reads hydrate bodies outside Catalog.
A previous failed preparation remains readable through its original public Operation after the user
corrects the request. Recovery closes lost inbound exchanges and records interrupted generation; it
never replays a paid request or an uncertain reply. Goal recovery uses retained short token facts,
not a new body read inside its recovery transaction; original provider usage fields remain in content.

The real application client, authenticated route, ThreadAdapter, runtime client and conversation UI
consume both reviews. Current Run configuration supplies the initial model suggestion, preserving
thinking and temperature=0; the user must explicitly generate. The output review names its actual
recipient and model. Stop addresses that exact generation Operation. Full JSON review does not grant
main tools or permit renderer-selected credentials.

## Confirmed failures and bounded repairs

1. A cancellation check discarded a completed provider item that had already reached the callback.
   The unchanged failing condition now preserves observed events/items/usage and their checkpoint
   before stopping the stream. It still produces no usable response after cancellation. Local stop
   is not proof of remote rollback, and unobserved future output is not invented.
2. Sampling reused Goal tool authorization but omitted the existing inference budget and usage
   contract. An exhausted Goal still dispatched, and actual sampling tokens never entered its total.
   Generation now freezes the original tool-origin Goal, checks and records dispatch atomically in
   the existing inference ledger, and measures its receipt exactly once on settlement or recovery.
   No Goal objective text enters the sampling prompt. The original budget/usage failures and pending,
   Actual/Missing recovery and duplicate-reopen cases have been independently rechecked.
3. A model removed from the actual catalog before generation returned a definite selection error,
   but the UI classified it as uncertain and stayed disabled after an unchanged refresh. The actual
   pre-admission boundary now supplies `admission: not_started` through route/client. UI correction
   uses that fact rather than a copied error-code list or an assumption about every HTTP 400.
   Genuine uncertain mutations still require changed durable evidence before another attempt.
4. After the old credential lease retired, a same-revision request choosing another model could
   have its native conflict swallowed as the previous generation's success. Definite rejection is
   preserved. A genuinely uncertain acknowledgement is reconciled through the original Operation's
   complete request, configuration and credential-scope identity, never just the edited text or ID.
   It neither generates twice nor changes the original model selection.
5. A normal Claude high-thinking selection was valid at its original capacity, but a smaller sampling
   maxTokens left a manual thinking budget larger than the actual output cap. The original Anthropic
   serialization boundary, also used for the resolved Bedrock fields, now rejects that unsupported
   no-tools combination before dispatch. Reviewed thinking is not silently lowered and the server
   cap is not raised. The vendor's [manual thinking constraint](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
   governs this check; tool/interleaved behavior is not broadened by this slice.
6. The existing provider regression suite caught a role-mapping regression: ordinary typed policy
   output was changed from external user-role evidence to assistant-role history when sampling roles
   were introduced. Only sampling-provenance output may now use its reviewed role. Ordinary typed
   output retains its previous external-data role, while original textual policy output remains
   assistant history. Both existing contracts are checked across the original provider consumers.

The lead's two early fixture failures were missing original adapter metadata and missing short
Operation-status forwarding in the fixture. They were corrected as test plumbing and are not counted
as product defects. An initial independent Task fixture also used the wrong accepted-body shape;
only its corrected original-authority path is evidence.

## Verification and reproduction

Final source-selected evidence passed:

- Fifteen original Rust/Host/installed-MCP/public-consumer compositions, including the four sampling
  cases below and existing resource, Task, form/URL, error-source, policy, child and nested callers.
- Twenty-five original provider behavior cases with the seven listener-based cases explicitly
  excluded, six sampling semantic/collector cases, the original supervisor teardown case, and
  twenty-five Goal/HostJob/sampling-accounting integration cases.
- Sixteen installed SDK lifecycle/interaction/resource/Task cases; sixty-nine original Host,
  credential, public-consumer and sampling-owner cases; 108 shared UI behavior cases.
- Independent original failure probes: four native Goal accounting/recovery cases, nine native
  Task/source/Goal/cancel/reopen cases, one real Host model-configuration to native serializer case,
  two installed HTTP association/reply cases and four real public/client/route/owner/UI cases.
  All independent native probes were relinked after the final provider-role repair. These evidence
  classes are not an aggregate coverage percentage.
- Fresh Pi build and complete source/test types; Host production/test and UI types; changed-source
  lint; wire generation check; fresh Host, CLI, extension-builtins and Web UI/PWA builds. Existing
  warnings were retained without unrelated cleanup.

The checked non-documentation input manifest contains 5,017 files, SHA-256
`494650f8a38ac9ed090d341e461ab08e587223be1cb2b8818f62df9193461dd5`.
Final native tests and builds use this same frozen input set. The fresh Linux x64 kernel is staged
with build identity `0.9.25`, wire **9**, manifest schema **3**, binary SHA-256
`561e100922cdd321e2f166bb9a725ff9db9a0280ae451503c3e14c462a07df9d`.
The Host production bundle contains 554 reachable modules and excludes 120 legacy/test artifacts.
The cloud production layout consumes these fresh outputs; its dependency graph is unchanged and
formatting-only lock refresh is not committed.

The native composition uses an actual MCP stdio subprocess or the installed HTTP transport with
in-memory fetch. Its model adapter retains the original builtin serializer/parser and substitutes
only a controlled response stream. It exercises private credentials and the actual public review
entry, without a listener, product socket, external account or paid model. These boundaries distinguish
it from component tests and from complete installed-product/platform acceptance.

The focused native entry is:

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  original_mcp_sampling_reviews_bind_real_model_operations_credentials_and_exact_replies \
  -- --ignored --test-threads=1
```

Its four original compositions cover HTTP editing and preparation correction, accepted stdio Task
sampling after the parent Run retires and its normal credential cleanup runs, output rejection, and
precise generation Stop. They verify exact model requests, roles/images/parameters, actual usage,
original provider items, once-only replies, previous attempt reads, GC and reopening.

Other relevant entries are `mcp_sampling::tests`, the `mcp_sampling_goals` integration target,
`mcp-sampling-runtime.test.ts`, `thread-mcp-interactions.test.ts`, and the existing
ThreadMcpSampling/ThreadMcpInteraction/ThreadConversation behavior suites. The original MCP ignored
composition suite also covers resource, Task, form/URL, error-source, policy, source-less child and
installed nested consumers. Run only the documented no-listener selections in restricted environments.

Full product IPC, actual Desktop/browser/provider behavior, paid-model quality/latency and platform
performance are not established by controlled streams. The overall two-design implementation remains
open. Final default-runtime switching, Pi removal and user-asset migration remain with the user after
acceptance; this slice does not perform that migration.
