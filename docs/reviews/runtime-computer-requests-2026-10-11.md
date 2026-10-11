# Native child Computer requests and durable observations

Date: 2026-10-11. Baseline: `2316308c3e3a5a6645bf6593b1254f7799bcf79f`.
Status: finite slice accepted after independent lifecycle and actual-consumer review. Complete IPC,
source-less child and platform acceptance are outside this result.

The later [source-free child slice](runtime-source-free-children-2026-10-11.md) addresses the admission
gap below; the evidence in this record remains scoped to its own baseline.

This slice connects **existing real source-bearing child tasks** to the original Computer request,
assignment and input owner. It includes ModelStep and PolicyAction calls, root Environment delivery,
idle-root user decisions, durable request observations and child lifetime cleanup. The existing public
ChildTask admission still requires a real file source. **Pure-capability source-less child dispatch is
unfinished and is the next implementation priority**; controlled source-less actors do not prove that
path. Source-less root Computer already works. General human-handback continuation and persistent
Computer scripts remain separate work. This is not complete Computer, platform or two-design acceptance.

## Execution, control and content ownership

The shipped Computer package's single declaration now supplies eleven tools, including request,
access, grant, deny and explicit request Wait. Its actual immutable broker runtime and ordinary
ToolBridge remain the call path. Original extension selection and per-call permission govern callable
tools; desktop allocation never adds a second permission/tool-name grant. Native actors carry explicit
per-invocation policy; Pi retains its read-only role semantics.

Catalog owns request identity, decision claim, original Operation/Wait and input facts. A worker
persists request/reason/history content first, then one short commit accepts both request and typed
root Environment input. A request result is acceptance, not desktop assignment. Only the original
ComputerService/Automation proves physical reservation, input effect and release. A claim retains
original user key or tool Operation, decision/reason identity, Host epoch and assignment ID. Changed
choice/reason conflicts; lost publication reconciles that exact claim. Missing old reservations and
new Host epochs do not automatically repeat allocation or input.

A physical assignment must be ready before `granted` publication. A terminal requester or cancelled
decision Operation that wins publication prevents grant and releases the captured reservation. An
accepted user decision survives view/transport cancellation; actual tool cancellation remains tied to
its invocation. Historical `granted`, current `released`, current `unavailable`, and unknown physical
cleanup are distinct. Short reconciliation does not hydrate historical request reasons.

`computer_wait` accepts a Job and parks through the existing observation machinery. Original decision
before or after registration produces one Environment fact, including after reopen. Cancelling this
observation does not cancel the request, child or assignment. Request notification interrupts only a
proven root child-Wait/delegated-execution path to the requester; an unrelated child Wait is retained.
Idle-root activation uses original launch capture and normal Goal/pause/question boundaries. A
terminal requester invalidates an undelivered notification instead of launching stale root work.

Native assignment lifetime follows its own requester Run, independently of a root's final response or
new Run. Explicit root Stop captures its affected family; exact child Stop targets that execution.
Captured physical cleanup starts before waiting for Catalog cancellation. Metadata-only request
reconciliation and actual accepted-Run inspection remain independent of public detail hydration.
Natural completed/failed/cancelled requester facts release the original assignment without requiring
an explicit model release call. Existing unknown-effect and original-helper release barriers remain.

The public application-client reaches authenticated registered state/decide/stop routes and the same
owners. Native root UI can grant/deny pending requests even when idle. An idle root also exposes exact
Stop for a live child assignment. Captured request revisions, original work/Run and existing UI
Host-selection generations fence stale decisions and replies.

Catalog format **43**, input domain **6**, and desktop runtime format **3** reject obsolete internal
records directly. External workspace assets are preserved. Content roots include original request,
decision reason and historical decided-event detail; no new body store or physical-control ledger.

## Confirmed integration issues

- An idle root with a live independent child control lease exposed no Stop. The independent failing
  DOM-to-real-client probe now passes with that exact child execution/desktop in the request body.
  Child default Stop also selects its own current execution rather than the root's Run.
- An unreadable unrelated request reason blocked all accepted-Run terminal inspection and physical
  cleanup. The original real ComputerService/controlled-helper probe failed, then passed after control
  reconciliation was isolated. On the final short-record contract it performs actual controlled input,
  completes the Run and clears its original physical marker while public state still reports the body
  error. This does not establish physical hardware release.
- Source review found grant-claim recovery depended on the same body projection. The first attempted
  before probe overlapped the RPC response change and is **not** counted as an observed product failure.
  Independent post-fix fault injection confirms a reserved assignment with failed first settlement
  recovers its same claim despite unrelated historical body-read failure.
- The original pending physical-marker fallback waited behind Catalog request cancellation. Its owning
  controlled-delay regression now verifies physical cleanup starts while that cancellation is pending.

- Independent cross-layer review then found accepted Native requests emitted no Computer projection
  change while the root Run stayed the same; an already open overview only showed its decision buttons
  after manual refresh. The actual shipped request/owner failure was reproduced. The corrected short
  Native invalidation reaches the real event parser, hook and original client/registered route reader.
  Pending buttons now appear without a root-Run change; subsequent physical events preserve them and
  denial updates them. Bad body content leaves request acceptance successful and shows UI error/Retry.
  Request execution and physical cleanup do not wait for projection.
- That live consumer review also reproduced an old EventSource delivering into a replacement Host.
  The original three callbacks now check their source instance. The original failing test and actual
  switched-endpoint probe confirm stale messages neither trigger new reads nor close the new stream.

No speculative timeout, duplicate request cache or permission list was introduced to address these
failures. Cancel scope comes from the original Catalog records, not whether Host happened to list them.

## Verification and reproduction

- Actual Rust Catalog combination: **253 passed** across runtime library and eight affected integration
  suites. This includes the new real-child request/Wait tests, shared message/child/Host Job/follow-up
  continuations, policy control and process observations; it is not the complete runtime test suite.
- Lead's additional actual-Catalog public-admission probes: **4 passed**, covering idle-root new Run and
  Environment history, terminal requester invalidation, unrelated real child Wait preservation, and
  both origins' manager-tool cancellation winning grant publication. They use the original admitted
  child/source fixture, not manually inserted child rows.
- Original Computer/Pi owner suites: **87 passed, 1 socket case excluded**. Native owner/invocation
  suites: **23 passed**. These preserve original owner semantics using controlled domain ports.
- Application-client: **10 passed**. Four affected UI files passed **97** before the idle-root Stop
  correction; the three changed files then passed **93**, and the final activity file passed **11**.
  After C3, the final two affected event/activity files passed **24** with complete UI types and lint.
  The independent original idle-root and two live-notification probes passed **3/3** through the actual
  parser/hook/client/registered route. Their transport remains controlled, not a listening SSE socket.
- Kernel all-targets check, Host production and complete Host-test types, client/UI types, changed-source
  lint and generated protocol checks passed apart from the existing `prefer-const` report at
  `application-host/index.ts`’s deferred `computerRuntime` declaration; that unrelated line is unchanged.
  A fresh Linux x64 release kernel was built and staged under identity `0.9.25`; its 14 existing warnings
  are outside this change. The late notification-only corrections did not alter Rust or kernel schema. The final actual Host bundle has **544 reachable modules /
  72 excluded legacy or test artifacts**; the built Computer manifest contains all eleven declared tools.

The independent cross-layer probe uses the actual shipped package, broker process, ToolBridge and
ComputerService. Both origins execute request → JobAccepted Wait → root grant → child observe/input →
release. Denial produces no physical input. Separately, the actual HTTP client reaches registered
Express authentication/routes through an in-memory transport: idle-root decision, original-key retry
and exact child Stop are observed. Catalog query/decision ports and the physical driver are controlled
in those probes. Actual Rust durability and history are established separately by the tests above;
these results are not a complete HTTP/kernel-IPC execution.

Independent review found no remaining confirmed blocker in this finite slice. The final production
probe also checks all three natural child terminal states, an accepted user decision surviving real
client-abort/route-disconnect, and the original tool cancellation retaining unknown effect. These are
separate facts from physical hardware or full Rust IPC acceptance.

The final **5,245** tracked/unignored kernel/package/script inputs excluding Markdown have manifest
SHA-256 `5570b10f00d0fd650dcfa52b295217de0d57858bd4ef60f81f8515e0e5de693c`.
The staged Linux kernel SHA-256 is
`b350310c603fc1a749dfa1252a59d9c40213221a543d05c2d2e56d6c21bd646a`.
The actual Computer distribution fingerprint is
`sha256-285b51234f5a028153bbe89b850d66e47c7c159143ec2814a16ee8b0faeb6b9c`.

Useful repository reproduction entry points with the locked tools:

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --lib \
  --test computer_request_review --test message_request_review --test policy_child_review \
  --test host_job_review --test delegated_continuation_review --test followup_continuation \
  --test policy_control_review --test process_wait_review -- --test-threads=2
node --import tsx --test \
  packages/web/application-host/lib/kernel/computer-runtime.test.ts \
  packages/web/application-host/lib/kernel/tool-invocation.test.ts
node node_modules/vitest/vitest.mjs run --config packages/web/vitest.config.ts \
  packages/web/application-host/lib/computer/computer-service.test.ts \
  packages/web/application-host/lib/computer/computer-actor.test.ts \
  packages/web/application-host/lib/computer/computer-automation.test.ts \
  --maxWorkers=2 -t '^(?!.*enforces assignments on the actual remote Host).*'
bun run --cwd packages/ui test -- src/lib/varinEvents.test.ts \
  src/components/pi-session/PiComputerActivity.behavior.test.tsx --maxWorkers=2
bun run --cwd packages/extension-builtins build
bun run --cwd packages/web type-check:application-host:raw
bun run --cwd packages/web build:application-host
```

The earlier full root fixture, `packages/web/application-host/lib/kernel/computer-review.native.test.ts`,
remains typechecked but unrun here because local socket listening is unavailable. It does not yet
represent this entire child lifecycle. The maintainer's earlier Windows acceptance is evidence for
that earlier baseline only. Actual desktop input, remote Hosts, complete IPC and installed-product or
performance acceptance remain open. User acceptance precedes the user's own default-runtime cutover,
Pi removal and broad asset migration.
