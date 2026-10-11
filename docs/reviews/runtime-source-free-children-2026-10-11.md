# Source-free native child execution

Date: 2026-10-11. Baseline: `90d6280077da8c083f07c37bb7946bd563208c6e`.
Status: finite slice accepted after independent cross-owner review and final integration verification.

This slice closes real ChildTask admission without a file source. It uses the same original dispatch,
frozen configuration, context preparation, child Run, report, Wait and later execution owners as
source-bearing work. It does not manufacture a directory, file grant or source pin to make ordinary
capability work admissible. Trusted Computer handback, persistent Computer scripts and the remaining
two-design capabilities are separate work; complete IPC and platform acceptance remain open.

## Common contract and actual consumers

`ChildSource::Absent` records the original invocation's lack of file authority. `Pending`, ready source,
and an unprepared successor's null source remain distinct. Both authorization and execution compare
the real source binding with the frozen invocation; preparation cannot downgrade a source-bearing
child into absent. `ChildCodeResult::NotApplicable` describes only the file-result axis. It is not a
successful report, empty diff, known business effect, stopped executor or desktop assignment.

The owning dispatch declaration is callable without a file binding. Native descriptors and exact
extension/MCP bindings supply source requirements; the repeated physical-tool name list is removed.
Ordinary extension effects keep per-call permission under either file work mode. Workspace MCP keeps
its actual source requirement even when its configuration file is global; neutral global execution
scope can remain source-free. No new tool grant or secondary directory is introduced.

The original settings owner freezes `tools_source: default | explicit`. Only distribution defaults
are derived against the actual frozen source and owning descriptors. Explicit saved arrays, empty
custom selections and explicit dispatch narrowing remain exact. Source-dependent selections name the
unavailable tools and explain how to select a source or source-independent tools. A repeated accepted
input/model key retains its original configuration, even after settings change or become unreadable.

The original Host context preparer accepts null source and preserves worker role, inherited context,
resources, model/credential scope and applicable instructions. No source capture or file branch is
created. The same collaboration owner handles initial dispatch and User, message, follow-up and
calendar successors. Absent successors carry no file-result basis to clone. Original Goal, pause,
input/Run and report controls still apply; the file-writer barrier is not expanded into a new ban on
independent Thread Jobs. Existing source-bearing readonly/private-write result and release behavior
continues through the same paths.

Public generated DTOs and the existing application-client require no parallel decoder. Shared child
and execution views say "No file source" and "File result not applicable" while keeping actual report,
unknown effects, Stop and continuation state. Catalog **44** and collaboration domain **8** reject old
internal formats directly; external configuration/workspace assets are not migrated.

## Verification and reproduction

- Runtime library and thirteen affected integration suites: **301 passed**, covering original
  source-bearing dispatch/profiles/delegation, source-null counterexamples, Computer requests,
  follow-up, Goal, message, independent Host Job, policy control and process Wait. This is a targeted
  combination, not the complete runtime suite.
- Kernel library: **148 passed, 11 ignored**. This includes actual source-free ModelStep/PolicyAction
  dispatch and child RunAssembly/Engine, ordinary effect authorization/denial, report, continuation,
  durable reopen and cancellation; Host execution replies are controlled. Original source-bearing
  capability, grant/pin and exact continuation boundaries also pass. All targets compile with the
  same 14 pre-existing warnings. A fresh `0.9.25` Linux x64 kernel then passed the original
  source-bearing child guardian/tree-stop/fixed-result test (**1 passed**) with real local processes.
  The other ten executable/PTY cases were not added to this slice's evidence.
- Host profile/continuation and common resource consumers: **28 passed**. The existing continuation
  table covers dispatch, User, message, follow-up and calendar with null context/source, exact trigger
  identity, real collaboration startup and zero file calls. Original file-backed calendar hold/retry
  remains covered. Full Host tests typecheck; changed Host/UI files pass targeted lint.
- Shared conversation UI: **71 passed** with complete UI types against the final generated protocol.
  Independent review also reran four affected source-free/file-backed lifecycle variants. A misleading
  "fixed source" description on source-free continuation was corrected to "source selection".
- The independent real settings/profile/model-selection owner exports its actual source-free context
  and frozen configuration. A separate public Catalog probe consumes those exact values, admits the
  child and runs the actual context compiler, retaining profile/global instructions, task, identity
  and resources. Default versus explicit choices, empty custom tools, accepted-key retries after
  invalid settings, model snapshot separation and reopen were exercised. This is a cross-language
  fixture handoff with controlled RPC/model-origin ports, not kernel wire IPC.
- A real local stdio MCP server reached through the original authority and child preparer produces
  one isolated effect for each origin; subsequent permission denial produces none. Exact binding
  restores, and a workspace-scoped binding from the same configuration source rejects missing file
  authority. Its invocation identity is controlled; it is not a fully admitted child over IPC.
- The lead's additional real Catalog nested-child probe passed: after a source-free child dispatches
  an independent nested Thread Job, its own terminal report and original Wait can complete, and a
  later absent-source execution can be admitted. The nested Operation is unchanged, not falsely
  settled by NotApplicable. Reopen preserves both; the original subtree Stop then captures nested
  and successor work without rewriting the original report.
- Protocol generation/check and the actual Host production bundle pass: **544 reachable modules /
  72 excluded legacy or test artifacts**. Documentation validation covers 224 engineering files and
  1,735 local links with no errors.

Independent review found no remaining confirmed blocker in this finite slice. Early external probe
failures were fixture assumptions (normalized cwd, selected model and missing current Run report),
not observed product failures. No blanket completion gate, new permission list, fallback source or
second configuration owner was added.

The final **5,246** tracked/unignored kernel/package/script inputs, excluding Markdown, have manifest
SHA-256 `f1f9fa68ed271d893563814c9dcdbb3ab3e532e015367f159ca81cf6772fef2a`.
The freshly staged Linux kernel SHA-256 is
`96c76e28b5ab5afb8f8327b640fdb43edb4d12c8c75f11d7ce523a23cb3edba7`.

Useful owning entry points:

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime \
  --test child_dispatch_review --test child_profiles_review --test child_host_delegation_review \
  --test delegated_continuation_review --test policy_child_review
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib source_free_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib child_capabilities::tests
node node_modules/vitest/vitest.mjs run \
  packages/web/application-host/lib/kernel/child-profiles.test.ts \
  packages/web/application-host/lib/kernel/child-continuation-host.test.ts \
  packages/web/application-host/lib/kernel/resource-consumers.test.ts
bun run --cwd packages/ui test -- src/components/thread/ThreadConversation.behavior.test.tsx --maxWorkers=2
bun run --cwd packages/ui type-check
bun run --cwd packages/web type-check:application-host:raw
bun run --cwd packages/web build:application-host
```

The owning native tests exercise actual declaration binding, dispatch authorization/execution,
Catalog admission and child RunAssembly/Engine with controlled Host replies. Separate real stdio MCP,
settings/context, public DTO/UI and durable Catalog probes establish their stated boundaries. These
are not complete socket-based kernel IPC or physical desktop execution. The native IPC fixture is
updated and typechecked but not run under this environment's established socket restriction. Earlier
maintainer Windows acceptance applies to its earlier baseline only. Final default-runtime cutover,
Pi removal and broad asset migration remain the user's work after acceptance.
