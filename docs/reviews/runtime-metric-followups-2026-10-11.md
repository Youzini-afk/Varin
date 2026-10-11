# Original machine metric conditions and durable continuation

Date: 2026-10-11. Baseline: `ffa802094a92fef3fb0ec6c5e368cc9e5773b9cf`.

This finite slice continues the two runtime designs and the maintainer's
[integration acceptance](runtime-2026-10-11.md). It implements machine resource conditions through
existing owners; complete product, platform and design acceptance remain separate.

## Conditions and original authorities

Ordinary `follow_up` version **8**, authenticated User registration and shared Follow-ups UI accept
`metric`, alone or in flat Any/All. A condition selects the original Host directory's `machineId`,
`cpu_percent`, `memory_mb`, `gpu_percent` or `gpu_memory_mb`, strict `above`/`below` and a finite
threshold. Memory values and thresholds use MiB (the existing field names remain `_mb`); percentage
dimensions use percent. GPU conditions require the original stable `gpuUuid`; a device ordinal is display data,
not a durable selector. CPU/memory conditions do not accept that field. No NVIDIA name parser or
capacity-based arbitrary threshold limit is duplicated in Catalog.

Every metric leaf retains the actual source Run and its original research scope, even when another
Any leaf is already satisfied. Host-global machine facts do not acquire a new workspace ACL, nor do
resource reads grant experiment submission/control. Machine Host/kind/backend/target identity remains
bound; a changed label or connection route alone is not a replacement physical machine.

ResourceService and its original Storage machine/sample records own measurements. Catalog **41 → 42**
directly rejects older internal formats and stores only short metric state and original accepted
source/occurrence evidence. It evaluates strict thresholds in the same transaction as sample cursor,
last-known predicate and accepted edge. There is no copied sample-history database or observer Job.
Initial known satisfaction emits once. Explicit Each requires another known false-to-true transition;
missing, stale, unreadable or disconnected values do not mean false or zero and cannot rearm held true.
Original sample record revisions, not timestamps, distinguish same-millisecond observations.

Any retains each accepted leaf edge; repeated All pairs oldest unconsumed facts without overwriting
pending A2 while waiting for B2. Original occurrence IDs bind Wait, input, history and root/child
activation. Cancellation of observation does not cancel a machine or experiment. Restart or Pause can
miss overwritten source samples: recovery checks current facts and records a gap rather than inventing
historical crossings. Already accepted edges remain durable and are not redelivered.

## Automatic sampling, cancellation and epochs

Inspection found that the old resource producer sampled only when a resource list was opened.
Merely subscribing would not implement automatic conditions. This slice adds shared sampling demand
to the existing ResourceService, distinct from its passive sample subscription. Native live leaves and
original Pi metric groups retain/release that same owner. One local demand starts sampling; compatible
additional consumers retain the existing cadence. The default is five seconds after the previous
flight completes, configurable at the owner, with no catch-up burst or per-definition timer.
Remote-only demand does not probe the local Host. No production remote sample writer exists in this
slice; remote conditions expose an actionable unsupported observation instead of fabricated coverage.

The OS/fixed nvidia-smi probe runs outside the original machine commitment lock. Only the machine/sample
CAS and allocation facts use that lock; release does not wait behind a slow probe. Admission uses the
actual committed inventory without a second locked probe or stale-GPU fallback. The GPU observation
budget is configurable and requests cancellation on expiry. Original probe completion waits for the
child's actual close; cancellation intent does not prove drainage. Last unused demand stops the timer
and cancels its otherwise unused flight. Host shutdown drains sampling without preventing original
accepted-job resource cleanup.

Original scoped handles are invalidated on kernel epochs. A probe commits through its captured actor
throughout the machine/sample sequence, including asynchronous boundaries; it cannot obtain a new
grant to write old measurements after reconnect. Recovery rebuilds actual demand from Catalog.

The Native adapter subscribes before each leaf's first snapshot. Per-live-leaf transient queues retain
callbacks until the original cursor confirms them. A held read/acceptance or lost response cannot
silently collapse false/true transitions into the latest sample. Callback observations retain the
availability determined by the original owner when received; a slow consumer cannot retroactively
turn known online edges into stale unknowns. A recovered/current head still uses current freshness.
Short work/demand discovery has an
independent flight, so Pause/Cancel can release demand while a read remains outstanding. Notifications
received during discovery cleanup recheck the original owner rather than disappearing between loops.
Delivery reconciliation is independent of receiving measurements.

## Public consumers and integration review

The finite public-entry map remains:

- Shared ThreadFollowups uses the existing `ThreadResearchAPI.resources` directory for the original
  Run, with UUID values and ordinal/name labels. It preserves uncertain request key/Run/trigger and
  rejects late directory replies after Host, Thread, branch or Run changes. Unknown values, gaps,
  original evidence and recovery guidance are displayed without executing markup.
- `threads-http` → authenticated registered `thread-routes` → `thread-followups` retains exact data,
  selected Thread/branch/Run and outer-field checks. Host does not add a metric-kind whitelist or grant.
  The original Rust registration decoder validates nested conditions and semantics.
- ModelStep and PolicyAction use the same owning declaration/registration owner. Actual child frozen
  tool directories preserve selected capabilities and real origin; only ModelStep has provider-paired
  tool output. Optional observation Wait uses the existing common barrier and original result history.
- `FollowupWait.kind` now derives from `FollowupTrigger['kind']`, eliminating another copied kind list
  exposed by consumer type checking. Private observer work types remain in the Host protocol; public
  consumers receive only their actual short state/evidence types.
- Pi retains its existing observation/delivery contract while its active machine groups share resource
  sampling demand. This does not claim Pi metric semantics were replaced by Native semantics.

Lead integration review corrected early callback deletion before acknowledgement, discovery blocked by
slow observation, and actor reacquisition inside the old-probe commit path. Focused regressions cover
the exact boundaries, including epoch change after probing and before machine write, and adding a
second consumer after the first flight settles. A broader owner run exposed one existing experiment
fixture's incomplete controlled resource port; only that fixture was updated. Production did not gain
an optional missing-sampler fallback.

Independent combination review reproduced one further concrete loss: fresh callbacks queued behind a
held read were re-evaluated after the freshness window, erasing an observed high/low/high sequence.
The correction retains the original callback-time observation in the existing leaf FIFO; no extra
history, freshness policy or storage owner is introduced. The unchanged failing sequence is part of
final verification.

## Verification

Independent review accepted this finite slice after the original callback-freshness failure passed
under the same held read/acceptance, delayed consumption and lost-reply conditions. Evidence is
separated by the boundary actually exercised:

- The locked broad Rust run passed runtime **445 / 0 failed / 2 ignored** and kernel
  **145 / 0 failed / 11 ignored**. Original Catalog tests exercise strict comparison, same-time
  revisions, unknown preserving holding, initial true, repeated edges, All FIFO across reopen,
  real successor Run/input/history and per-leaf scope denial inside an already-ready Any.
  This run preceded only the final unit explanation and Host-only callback correction. After the
  unit text change, the actual child assembly test passed both ModelStep and PolicyAction, original
  Wait/result delivery and reopen without a duplicate result. Final all-targets checking passed.
- The final Host owner/observer/research/public-route combination passed **77/77 in nine files** after
  the callback correction. It includes automatic no-panel demand, shared cadence, cancellation,
  the old scoped actor's machine-write epoch window, original experiments and observation consumers.
  Shared React behavior passed **68/68** after the MiB correction; complete UI types and lint passed.
- An independent source client → registered authenticated Host route → original Rust decoder probe
  accepted CPU/GPU/Each Any/All and rejected eight representative nested semantic cases at the
  owning decoder. Four private outer-authority injections remained Host errors. Its RPC and actor
  ports were controlled; it is not product IPC or Catalog source admission evidence.
- A separate independent actual ResourceService → actual observer combination used controlled
  Storage/Catalog/measurement/clock ports. Same-time callbacks, held read and acceptance, lost
  committed reply, Pause and reconnect preserved the original sample revision sequence. The original
  failure with a 120001 ms backlog now preserves the observed 0 → 95 → 0 → 99 sequence. Recovered
  stale heads and callbacks already stale at receipt remain unknown. These probes do not substitute
  a controlled Catalog port for native occurrence tests.
- An independent actual fixed GPU probe subprocess test verified that SIGKILL/parent exit does not
  resolve before inherited pipes close. Original resource release stayed independent; owner disposal
  waited for close. The external executable fixture is not GPU hardware or a driver/platform claim.
- Final Host production/test types, generated protocol check, changed TS/TSX lint, documentation
  checks and actual Host bundle passed. The final production bundle retained **541 reachable modules /
  72 excluded legacy/test artifacts**. Only the owning two Host files needed post-correction changes;
  no Rust behavior or product transport was modified to repair the queue.

The fresh Linux x64 debug kernel has identity `0.9.25`, target `x86_64-unknown-linux-gnu` and SHA-256
`d2283644b04f2768c9eaa075ef1d81972e7156f27b48ba90f59ef6d431fba09d`.
The original real child guardian/tree-stop/fixed-result regression passed **1/1** against that exact
executable. Final **5,231** tracked/unignored kernel/package/script inputs excluding Markdown were
unchanged through the last Host verification; the saved input manifest SHA-256 is
`b48aaacb6a7cf782534ec770885e302f801849d68b82c39aefc2ce15c04203ff`.
Independent review separately checked its 16 direct source inputs. No test totals are added together
to imply full end-to-end coverage.

## Reproduce

Use the locked tools from [development](../development.md), at repository root:

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime -p varin-kernel --locked -- --test-threads=2
cargo check --manifest-path kernel/Cargo.toml -p varin-runtime -p varin-kernel --all-targets --locked
(cd packages/web && bun x vitest run \
  application-host/lib/harness/resources.test.ts \
  application-host/lib/harness/gpu-resources.test.ts \
  application-host/lib/harness/experiments.test.ts \
  application-host/lib/kernel/metric-followups.test.ts \
  application-host/lib/kernel/research-runtime.test.ts \
  application-host/lib/kernel/research-artifact-followups.test.ts \
  application-host/lib/kernel/research-log-followups.test.ts \
  application-host/lib/kernel/thread-followups.test.ts \
  application-host/lib/kernel/thread-research.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadConversation.behavior.test.tsx)
node scripts/generate-kernel-protocol.mjs --check
bun run --cwd packages/web build:application-host
```

The existing `bun run test:kernel` lane includes `process-wait-review.native.test.ts`. The new real
HTTP/IPC case controls only physical measurement values: no resource panel or manual sample call
initiates the source, an initial false value becomes true, the original Thread gains one new Run,
and the same Storage is reopened without replay. It is retained for an environment supporting the
actual product transport. It has not executed in this cloud; Unix IPC listen remains unavailable.
The Pi `followups.native.test.ts` lane is likewise not counted as a local pass.

## Remaining work

Other domains and composition remain: Computer/handoff/remote, Web/material/PDF/scholarly/Bot,
MCP resources/prompts/Tasks, durable scripts, and remaining SourceView/retrieval/context/provider
integration and actionable preparation failures. Remote machine metrics require an actual authorized
producer before they can be claimed. Full Host/browser/platform/external-system/performance acceptance
remains distinct from this slice's evidence. Default runtime cutover, Pi removal and asset migration
remain with the user after acceptance.
