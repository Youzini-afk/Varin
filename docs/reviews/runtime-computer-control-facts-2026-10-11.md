# Trusted Computer control facts and original execution continuation

Date: 2026-10-11. Baseline: `48308d771f10734682253979eb3533425b23e89e`.
Status: finite slice accepted after independent cross-owner review and final integration verification.

This finite slice connects actual Native takeover, cancellation and human handback through the
original Computer owner, desktop outbox, Catalog input/history and root/real-child continuation.
Persistent Computer scripts and remaining two-design capabilities remain separate work. Full kernel
wire IPC, real desktops, remote deployments and platform/performance acceptance are not established.

## Contract and actual consumers

ComputerService still owns physical control, original helper release, assignments and observation
bindings. Catalog owns lineage, durable input acceptance, Run/Wait, Goal and delegated execution.
The original desktop outbox retains an immutable kind/ID/actor/desktop/time/release fact until a
definite receipt. The native adapter carries the original execution, while Catalog derives root
lineage and atomically accepts actor and optional passive root input. Body staging stays outside the
control transaction. Repeating a lost response returns the same receipt, not a second input or Run.

Takeover and cancellation are passive Environment facts. Eligible handback enters an active original
Run at its legal input boundary or creates a real root/child successor after natural completion.
Frozen launch/context, original report and absent/file-source semantics remain intact. It does not
become User input, manufacture a Goal, grant an assignment or restart an ended tool invocation.
A replacement execution makes a first late fact passive; already accepted activation uses the existing
pending-input owner. Goal pause/end/budget, questions and explicit cancellation remain authoritative.
Unrelated observation Waits are not interrupted.

Native natural completion releases the original assignment and observations but retains its original
interrupted-control provenance. After handback the same record is marked returned, without presenting
a human operator or restoring a lease. It supports precise Stop even after the input-acceptance ACK.
Only a new actual control assignment/takeover replaces it; an observer cannot. Restart reads this
original provenance separately from physical-release markers. Pi keeps its existing behavior.

Computer Stop captures exact actor/desktop scope. The original durable cancellation command fences
pending handbacks, including an in-flight body; old command replay cannot cancel future handback in
the same Run. Already delivered history and an already started successor are not undone. Tree Stop
records its captured Runs even when terminal, without rewriting terminal outcome. A late original
outbox fact cannot revive those Runs. Failed short cancellation keeps an actionable original target
and pending command; known physical release remains known rather than becoming a fabricated barrier.

Remote takeover release facts use the actual target control state, not the source Host's empty lane.
Fresh observation and current per-call bindings remain necessary after return. Catalog acceptance,
physical release and execution startup are distinct facts.

The public registered desktop routes and original native conversation Stop consumer use these same
owners. Generated protocol classifies event acceptance as body work and exact cancellation as short
control. The shared execution view displays Computer event/input and Calendar occurrence identity,
with exhaustive trigger presentation instead of mislabelling both as User continuation.
Catalog **45**, desktop runtime **4** reject old internal formats directly; no asset migration is added.

## Independent findings and repairs

The reviewer formed acceptance from the two designs and the maintainer's cross-layer review before
reading this implementation. Four concrete cross-owner failures were reproduced and repaired:

1. A root overview Stop visited unrelated loaded desktops. A write failure on an unassigned desktop
   polluted an otherwise released target's result. Stop now uses only its captured original scope.
2. Native `finishExecution` erased the original interruption, so a later real handback produced no
   event. Retaining original provenance closes natural-terminal return and idle desktop Stop without
   restoring the old execution's authority.
3. A remote target's `cancel-unconfirmed` takeover was reported as confirmed release from source-local
   state. The immutable notice now records the target's actual evidence.
4. After handback ACK, a failed exact cancellation could disappear from the desktop Stop projection.
   The same original target now survives, exposing cancellation uncertainty while preserving physical
   release; an actual user retry clears the original pending command.

Joint review also found auxiliary context-job Runs being selected as the latest branch owner.
Computer eligibility, common activation and delegated publication now share the original branch-owner
selector excluding actual context-job rows. Real root and child auxiliary-Run regressions preserve
frozen policy and admit the proper successor. This does not claim a global audit of every older
history, inheritance or public-view selector.

## Verification and reproduction

Final same-source verification:

- Runtime library plus ten affected integration suites: **266 passed**, including Computer control/
  requests, auxiliary context jobs, delegated/message/passive/follow-up inputs, Goal, policy controls
  and process Wait. This is a targeted combination, not the whole runtime suite.
- Kernel library: **149 passed, 11 ignored**; all targets compile with the same 14 existing warnings.
  The actual source-free child Engine regression includes a real same-branch auxiliary job before
  handback and real preparation/admission. After a fresh Linux x64 kernel build, the original
  source-bearing child guardian/tree Stop/fixed-result test passes (**1 passed**). An initial overly
  qualified test filter selected zero cases; it was not counted and was corrected to the actual test.
- Host native consumer: **23 passed**; original Computer owner: **86 passed, 1 explicitly excluded
  socket case**. Production/test types and changed-file lint pass. Shared conversation UI: **71 passed**,
  complete UI types and changed-file lint pass.
- Independent final owner probes: **13 passed**; focused original Pi/actual stdio controlled-helper
  consumers: **9 passed**; existing viewer/control consumers: **5 passed**. The four confirmed
  failures above are closed under their original triggering conditions.
- Protocol generation/check and actual Host bundle pass: **544 reachable modules / 72 excluded
  legacy or test artifacts**. Documentation check: **225 files / 1,738 local links / no errors**.

All tests use isolated fixtures; no user desktop or paid model is invoked.

- The lead's public Catalog combination covers root/real source-free-child new Run, original report,
  exact Stop before staged content, later handback surviving old Stop replay, unrelated Wait and tree
  cancellation. An initial probe assertion confused storage-node ID with conversation-item ID; the
  assertion was corrected to original event identity without a product change.
- A durable real Catalog exports its original root/child identity triples. Independent actual
  ComputerService, registered authenticated route, controlled driver and runtime adapter produce four
  unmodified commands using those identities. The same Catalog reopens and consumes them: six exact
  Environment history facts, real child preparation/admission, original report retained, then another
  reopen returns the same receipts without activation. This is a sequential cross-language fixture
  handoff, not a substitute IPC transport or a claim of wire-level E2E.
- Independent controlled owner probes cover the four original failing conditions, stale observation
  rejection/fresh action, lost ACK reconstruction, slow/failed body versus physical Stop, returned
  provenance/restart and explicit user Stop retry. Existing Pi and actual stdio controlled-helper
  consumers are separately exercised; they do not establish physical platform release.
- One owner-test negative-name filter accidentally included the previously unverified remote Host
  socket case. It failed an `accepted` assertion; no successful IPC result was obtained. It was not
  retried. Final owner runs exclude its exact original title. This failed attempt is separate from
  the final targeted pass evidence and does not change the existing environment boundary.

The final source-input manifest contains **5,248** tracked/unignored kernel/package/script inputs,
excluding Markdown, with SHA-256
`ed99656998ce01de220fbc5c81def1493d83f94bd7ce58dd472f1eca6b711b83`.
The staged Linux x64 ELF kernel has build identity **0.9.25** and SHA-256
`e38fe0262ca653d3b837139a1ab990514636c22fb027b2824420d5f33da99e87`.
The producer-to-Catalog fixture handoff was rerun against this final source with a new real Catalog,
unchanged exported identities and original commands; its new child Run, history and reopen checks pass.

Representative reproduction from the repository root (using the project's pinned toolchain):

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --lib \
  --test computer_control_review --test computer_request_review \
  --test context_job_review --test delegated_continuation_review \
  --test goal_lifecycle --test message_request_review --test passive_messages_review \
  --test followup_continuation --test process_wait_review --test policy_control_review \
  -- --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib -- --test-threads=2
cargo check --manifest-path kernel/Cargo.toml -p varin-kernel --all-targets
node --import tsx --test packages/web/application-host/lib/kernel/computer-runtime.test.ts
node node_modules/vitest/vitest.mjs run \
  packages/web/application-host/lib/computer/computer-automation.test.ts \
  packages/web/application-host/lib/computer/computer-service.test.ts \
  --testNamePattern='^(?!.*enforces assignments on the actual remote Host).*$'
bun run --cwd packages/ui test src/components/thread/ThreadConversation.behavior.test.tsx --maxWorkers=2
node scripts/generate-kernel-protocol.mjs --check
bun run --cwd packages/web build:application-host:raw
node scripts/docs/check-engineering-docs.mjs
```

The ignored guardian test additionally requires `VARIN_TEST_KERNEL_EXECUTABLE` pointing to a freshly
built kernel with the correct build identity. The complete HTTP/kernel-IPC fixture and real target
platform checks must be run in an environment that supports their required transport and hardware.

## Remaining delivery boundary

Persistent Native Computer scripts, remaining environment/Web/material/Bot/MCP and source/context/
provider capabilities still require implementation and their actual consumers. Broader branch-owner
selection callers warrant a separate concrete check where auxiliary Runs share a branch; only the
selectors exercised here are claimed. Full product/platform/external-system and performance acceptance
remain distinct. Final default runtime switching, Pi removal and asset migration remain the user's
post-acceptance responsibility.
