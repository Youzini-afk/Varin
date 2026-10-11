# Original-owner MCP Tasks and durable result observation

Date: 2026-10-11. Baseline: `7fb66c7024e91de7a89256b4e656d826b6ab58c8`.
Status: finite slice accepted after original-owner integration and independent review.

## Finite contract

The existing MCP authority, installed client and retained composition own connection, configuration,
credentials and grants. The existing Catalog Operation/HostJob owns dispatch, receiver acceptance,
observation, cancellation and result references. No second task database, client or credential owner
is added. The [owning MCP document](../../packages/web/application-host/lib/kernel/MCP.md) records
exact declaration, permission and lifetime semantics.

Server `tasks.requests.tools.call` and the tool's `execution.taskSupport` jointly determine behavior.
A required tool on a capable server becomes Job/Thread; optional/forbidden direct calls remain ordinary
RPC. Without Tasks capability, a required hint alone does not change RPC semantics. Explicit
`mcp_start_task` selects a supported optional/required tool and retains the original schema and args.
`mcp_task_get/wait/cancel` use the original local Operation ID, never an arbitrary remote Task ID.
All declarations/routes come from the protocol schema and reach child/recovered compositions.

Catalog **50** and Kernel wire **5** replace the previous internal formats directly; content **4**,
manifest **2** and policy **4** remain unchanged. HostJob subject explicitly distinguishes original
Workspace research work from MCP endpoint/dispatch identity. Source-less/global Tasks do not invent
a workspace. Original MCP/extension compositions can be frozen without a child directory; that does
not authorize child delegation. Research consumers retain their exact workspace guards.

Remote management tools use the same current permission rules, one-shot ask rendezvous and pre-entry
revalidation as ordinary tools. Get may refresh/reconnect, so it has a durable Result Operation with
no server dispatch claim and successful Effect None. Wait remains a durable observer Job. Automatic
polling and direct authenticated user follow-up controls do not repeatedly request tool permissions.

## Execution, cancellation, output and recovery

The actual receiver-created ID is accepted once, after original local dispatch intent. Acceptance
releases the MCP server dispatch occupancy in Catalog and shared admission memory; the remote Task
keeps its own retained lease after the calling Run finishes. Acceptance is not stop evidence.
A cancelled status or cancel ACK, missing Task, elapsed TTL or transport failure does not establish
physical stop. Completed/failed protocol status does establish terminal execution, independently of
whether `tasks/result` can supply the business result. Missing business results retain Unknown.

The original acceptance and any already-delivered Unknown call completion remain immutable. Eventual
Task JSON/error and ordered media live in the original ContentStore result reference, with original
provenance and public Operation/event readers. A late success can refine the Task without rewriting
a previous model exchange. Result Wait, original stopped-job follow-ups and cancelling an observer
are distinct facts. GC, history/forks and reopening follow the same original references.

Polling, result streaming and cancel are independent original-client requests. A pending get cannot
block cancellation. Equal/coarse protocol timestamps are fenced by the original observation revision,
so an earlier in-flight working snapshot cannot replace a locally published terminal status. Unknown
creation is never replayed or guessed from `tasks/list`. A live Host holding the actual acceptance
may retry only its identical local Catalog publication after an interrupted acknowledgement. Reopen
resumes a known ID using the exact frozen owner/source/grant; unavailable or changed owners are visible.

`input_required` opens the actual result request and preserves the original SDK roots handler and
related-task association. Sampling/elicitation are unadvertised and explicitly unsupported here.
This is not a claim of general interactive Task support. Resource subscriptions and update delivery
remain a subsequent capability.

## Cross-layer defects found during this slice

The independent reviewer started from the two designs and the maintainer's fourteen integration
findings. Concrete failures, rather than hypothetical limits, determined the corrections:

1. A real related-task `roots/list` response lost its `_meta` association in the installed SDK handler.
   The maintained SDK patch now carries the original request association through the original response.
2. Task management bypassed explicit tool policy. Original get/wait/cancel now share the same permission
   gate, ask/consume and execution-time generation checks. Actual deny, ask-once and changed-policy
   probes use the real PermissionService; their controlled Catalog port is not represented as Rust IPC.
3. A new result Wait consumed an old unavailable event after observation recovered. Registration now
   consults current result/availability and fences future facts; already-triggered Waits retain their
   original event. The original Catalog failure and fixed behavior were both reproduced.
4. Wait delivery prepended explanatory text and shifted original `outputPartIndex` references. The
   common typed-output wrapper now appends its explanation, retaining original data and part positions.
   Independent real history delivery checks original PNG bytes, provenance and both media/text indices.
5. An unsupported cancel request marked an otherwise observable working Task unavailable. The original
   stdio peer advertised get/result but no cancel; successful status reads proved the distinction.
   The original unchanged probe now retains working/available plus the actionable cancel diagnostic.
   Prior result/interaction errors remain primary; a later successful status read can recover a prior
   status/rebind outage. The merge reads current facts inside the existing short publication queue.

Lead integration also exposed missing frozen MCP composition when no child directory was selected;
the original composition owner now records these bindings without manufacturing a delegation grant.
Two test-harness errors were corrected separately: the observer Run must use the production
ObservationPolicy, and the deliberately interrupted local acceptance reply is an expected diagnostic,
not a Host crash. An already committed acceptance correctly keeps JobAccepted despite a lost ACK;
requiring Unknown there was also a test-expectation error. These are not counted as production repairs.

## Reproduce the original composition

After the normal protocol and Pi Host builds, the narrow ignored integration uses the original Rust
Engine, RunTools, Catalog, ContentStore and supervisor; original Host ToolBridge/PermissionService,
production Task coordinator/recovery; and a real installed MCP client and stdio peer. The peer controls
remote work deterministically, without a product socket or external model service.

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  agent_runtime::mcp_task_review -- --ignored --nocapture --test-threads=1
```

- Main lifecycle: model Tasks and a distinct same-server call after acceptance; real PolicyAction,
  input-required roots; normal Run retirement; blocked get plus independent cancel and observed work
  continuing after the ACK; exact-ID Host/Catalog reopen; durable result Wait/resumed model, get, media,
  history/fork/GC, and no remote creation replay.
- Consumers: a real source-less child and an actually installed brokered SDK extension invoke Task/get
  using original child/nested origins. Original acceptance, output and owner remain intact.
- Lost local acceptance reply, two actual cases: commit-before-interruption retains canonical
  JobAccepted and lets the normal Run finish; failure-before-commit first delivers Unknown and the
  default policy stops. Both subsequently reconcile only the same known receiver ID, retain eventual
  output and preserve their original call/history exactly. Remote creation occurs once per case.

Additional scoped evidence covers the real installed MCP client/declaration/grant seams, original
Host coordinator fault injection, research/follow-up consumers, the authenticated media route and
shared UI. These layers are reported separately from the cross-language original-owner tests.
The three original-chain tests pass (including both acceptance interruption cases). Scoped regression
runs pass 95 original Catalog/Job/Wait/continuation/child/nested/composition cases and 47 Catalog unit
cases; all runtime test targets compile. These do not stand in for the original-chain evidence.

The installed MCP Task owner tests pass 3 cases, and original authority/HTTP lifecycle regressions pass
10. Host coordinator plus management permission regressions pass 13; research/follow-up consumers
pass 60. The actual application-client → authenticated route → ThreadAdapter → AgentRuntimeClient
media-holder tests pass 3; shared UI behavior passes 74. Type checks cover Host production and tests,
Pi Host and UI; changed-source lint, protocol generation and engineering documentation checks pass.
The final minor UI error label separately distinguishes unsupported interaction from another unsupported
Task operation; it changes no routing or authority.

The normal Host bundle contains 550 reachable production modules and excludes 96 legacy/test artifacts.
CLI and Web assets build, and the ordinary cloud-runtime staging/lock refresh verifies the production
layout. Both lock graphs are semantically unchanged; formatting-only regeneration is not retained.
Maintained SDK patches were installed normally and reverse-checked against the installed bytes.
This staging is not an installed-product smoke or deployment.

The freshly built Linux x64 ELF is staged with build identity 0.9.25 and wire 5, SHA-256
`a037245e4f0bbdbe385618bb1a342cedfae07eb8e184516a170de5013598b5da`.
The source freeze covers 4,982 non-documentation kernel/package/script/example and root build inputs,
SHA-256 `c6f18d1701d2fcc3183d03de26019822dc4c07bb7dc1ce908d25fe260c65b55e`.
The fourteen existing kernel warnings remain; no unrelated warning cleanup is included.

## Remaining boundary

No complete product socket IPC, real desktop, external MCP deployment, remote model, cross-platform
package or performance acceptance is claimed. The maintainer's earlier Windows evidence remains
scoped to its own commit and cases. This phase does not complete the two overall designs: MCP server
interactions/subscriptions and remaining environment, Web/materials/PDF/academic/Bot, source/retrieval,
context/provider capabilities still need implementation or acceptance. The user retains final default
runtime switching, Pi removal and asset migration after their acceptance.
