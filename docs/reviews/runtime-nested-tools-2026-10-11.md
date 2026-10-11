# Original nested tool invocation

Date: 2026-10-11. Baseline: `be1af56a6415ab37a1ce8335c8631d1cae140395`.
Status: finite slice accepted after independent original-owner review and final integration checks.

This bounded slice implements ordinary extension tool composition through the original SDK, broker,
Host invocation and native executor. Persistent Computer/script environments and typed model media
remain later work. Full product socket IPC, physical desktops, remote/platform behavior and performance
acceptance are not established by these controlled tests.

## Shared authority and actual consumers

`call.tools.invoke({ callId, name, arguments })` resolves only the original invocation's frozen selected
directory. The Host supplies its verified parent Operation and executor identity; Rust decodes the
complete original input. There is no separate enabled-tool list, caller-provided Run/source/grant,
fabricated ModelStep or second receipt database. The actual `NestedCall` parent relation is persisted
with effectful/Job tool intents. Canonical IDs length-prefix the parent's UTF-8 bytes, avoiding deep
separator and Unicode collisions. Pure reads keep their original transient path.

The shared `InvocationRunner` owns actual planning, preparation, authorization, resource/capacity
admission, dispatch reauthorization, execution and settlement for model, policy and nested calls.
Catalog resolves original model/policy/source boundaries through immutable parent intents. Source,
resources, family reads, child dispatch, Goal and permission consumers use that same origin. The
existing retained extension/MCP pin and explicit revocation remain authoritative.

The transient scope closes admission atomically before draining actual registered calls. A detached
extension promise does not orphan a foreground callback. Exact nested Stop and parent cancellation
reach the original token; a broker observer rejection is not physical-stop evidence. An original
executor returning Unknown with `executor_stopped: false` finishes the callback but leaves its own
Operation and occupancy unresolved. The outer Operation describes its own callback/direct effects;
it does not duplicate child Unknown as an unreconcilable permanent aggregate. Accepted independent
Jobs retain their original owner/lifetime. Duplicate exact input shares its actual call/receipt;
changed input conflicts, and closed/restarted scopes cannot redispatch.

Inner calls never create unsolicited model ToolResults. Memory delivery authenticates the original
inner memory Operation and commit receipt independently of outer printed/returned JSON. The same
memory owner retains commit/revision/recovery; no second consumption log is introduced. Ordinary
result bodies and immutable arguments remain in ContentStore, prepared outside Catalog locks.
Catalog **46** rejects older internal formats directly; external assets are not migrated.

The existing deferred response-credit mechanism now includes nested invocation in the protocol
schema. Only a complete body accepted by the original live worker releases transfer credit; the
pending cancellation token and final response remain. At request window two, two nested calls or an
additional nesting level can therefore request their original permissions/domain services without
exhausting the transport window. This does not raise a limit or move bodies into the control lane.

## Evidence boundaries and reproduction

The installable [nested-tools example](../../examples/extensions/nested-tools/README.md) registers
the actual SDK tool declaration and preserves original memory/read receipts. Its consumer tests and
CLI bundle/activation checks establish the authoring contract, not a real kernel dispatch by themselves.

Two complementary original-owner integrations cover the cross-language path:

- The installed example passes through real ArtifactStore installation/capability review, broker,
  retained extension ToolBridge, original invocation scope and runtime capability into the real
  MemoryBridge, MemoryOwner and AgentPersonalization. Kernel management/dispatch and atomic Storage
  record primitives are controlled fixtures for this Host segment.
- The native test uses real child admission, RunAssembly, Engine, NestedTools and MemoryTools. Original
  memory-request frames reach those same Host memory owners over a test-only Node stdin/stdout helper.
  The outer callback and Storage primitives are controlled; this is not a replacement product transport.
  Both actual outer origins are covered, with no echoed memory receipt; one callback fails after the
  committed write. The next actual RequestView contains one trusted memory fact, no inner provider
  pair; reopen recovers the same receipt and a Host receipt query does not execute the write again.

Representative focused entry points with matching built workspace packages:

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test nested_invocation_review
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime nested_tools::tests
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib nested_credit_tests
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  nested_memory_uses_original_host_owner_and_delivers_once_without_outer_echo -- --ignored
node --import tsx --test packages/web/application-host/lib/kernel/nested-tool-owner.test.ts \
  packages/web/application-host/lib/kernel/tool-invocation.test.ts \
  packages/web/application-host/lib/kernel/request-credit.test.ts
cd packages/web
node ../../node_modules/vitest/vitest.mjs run application-host/lib/kernel/nested-tools-installed.test.ts
```

## Integration verification

- All 37 runtime library/integration targets were compiled and exercised, with **458 final passing
  cases, 2 ignored and 7 explicitly excluded socket-dependent cases**. The first full build found a
  two-origin Computer test fixture missing the new enum arm; its fixture now explicitly rejects that
  unconstructed case. The first broad execution found one negative resource-read assertion expecting
  rejection during body loading. The shared short metadata capture now rejects the mismatched node
  earlier; only that assertion changed. Its entire suite and the remaining source-inheritance suite
  passed on rerun (**14 cases**), with no production relaxation. Doc tests contain zero cases.
- Kernel library **150 passed / 12 ignored**; all targets compile with the same 14 existing warnings.
  The explicit ignored native/Host memory test passes after strengthening the policy callback to fail
  after its memory write. That test's one case includes both actual outer origins.
- Original Host bridge, extension owner, deferred-credit and installed consumer tests: **24 passed**;
  scope/capability Node tests: **7 passed**. One initial concurrent four-file run timed out at the old
  one-second A→B recovery poll. The unchanged case passed isolated, and all four files passed serially;
  no timeout or product logic was changed to hide it. The failed attempt remains separate evidence.
- Generated protocol check, Host production/test types, application-client build, full UI types and
  changed-source lint pass. The actual Host bundle contains **545 reachable modules**, excluding
  **76 legacy/test artifacts**. The example's two authoring tests, strict types and real CLI bundle/
  activation check pass separately; they are not added to a product-E2E total.

The seven omitted runtime tests are the five `providers::tests` HTTP/SSE transport cases, the injected
credential-broker HTTP factory case, and the chat/Azure protocol/header factory case. Their listeners
require a transport capability this environment previously denied. No listener was retried or bypassed;
the new original KernelClient window-two tests use controlled transport frames, and the memory helper
uses test stdio. The maintainer's earlier Windows acceptance remains evidence for its own baseline.

The freshly built/staged Linux x64 ELF kernel has build identity **0.9.25**, SHA-256
`0c744a559c596dac63d4aaa1c54ff48cbed617c465c96415fcb121bbd06f098b`, and passes the original real
child guardian/tree Stop/fixed-result regression (**1 passed**). The final source-input manifest covers
**4,928** non-Markdown tracked/unignored kernel/package/script/example inputs and root package/lock/type
configuration, SHA-256 `96ea2d070252b696251acdf6c281aadc6aaa68fc5ee5d082309a77ce8c6d5a05`.
The manifest was rechecked after verification without changed inputs. Engineering docs validate
**227 files / 1,746 local links / no errors**.

## Independent original-owner review

The reviewer formed acceptance from both designs before reading the frozen implementation. The
final independent judgment accepts this slice with no confirmed remaining release blocker. The
explicitly ordered Job probe uses the original QuestionPolicy/declaration and actual runtime Engine
under model and policy outer calls: accept a nested question, hold the outer callback, then try an
answer. The Run is still Executing or Runnable, so the existing question owner rejects the early
answer without changing branch head or resumptions. After the outer receipt closes, the original
question remains alive, the Run becomes Waiting, and one answer makes it Runnable. No Run state was
manually changed. The suspected premature-consumption failure was not reproduced; no additional
history guard or consumption ledger was added. This establishes rejection until the legal boundary,
not durable pre-acceptance of early answers.

The finite Computer probe uses the original Host invocation, ComputerRuntime, ComputerService and
assignment/input lane. A NestedCall with either parent origin and no file source retains its actual
child Thread/branch/Run and canonical inner Operation. Missing assignment rejects; observation-only
assignment permits observation but rejects input; the original control assignment dispatches once;
disabling the owner rejects again. Catalog scope, Storage primitives and driver are controlled in
this probe. It does not establish full Catalog child dispatch, permission-dialog or desktop behavior.

The existing actual nested tests independently revalidate pending foreground drain, exact nested and
parent Stop, returned Unknown occupancy and later original-receipt refinement after reopen. Refining
the inner effect leaves the outer receipt unchanged. Initial external-probe failures from a missing
QuestionPolicy, an incorrect policy-Run state expectation and temporary TypeScript module setup were
corrected in the probes without changing production code or being counted as implementation defects.

## Remaining delivery boundary

This slice provides actual tool composition, original receipts and cancellation/recovery integration.
It does not yet provide a persistent script environment, shared async cells/objects, or typed image
delivery into model providers. Those require the original selected environment/process/guardian and
content/provider owners, not unrestricted Host Node access or a JSON screenshot label. Remaining
environment, Web/material/Bot/MCP, source/context/provider and full product/platform/performance work
continues under the two designs. Final default runtime switching, Pi removal and user asset migration
remain the user's post-acceptance responsibility.
