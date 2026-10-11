# Managed persistent JavaScript environments

Date: 2026-10-11. Baseline: `a51d13f85c1c77c4517a6f632eb5797febf11514`.
Status: finite slice accepted after final original-owner integration and independent review.

This finite slice connects ordinary `script_open`, `script_run` and `script_close` to a real,
Run-owned Node environment. It covers full async cells, persistent lexical/object state, original
nested tools and real lifecycle owners. Typed media and higher-level Computer app bindings remain
separate work. Product socket IPC, real desktops, packaged operating systems and remote execution
have not been established by the controlled integrations here.

## Ownership and execution contract

The ordinary built-in `varin.builtin.scripts` uses the existing SDK, service broker, selected immutable
binding, permissions and Host invocation. `script_open` accepts an Environment Job whose ID is the
original open Operation. Cells and close requests are separate Operations in that same Run. The
selected physical source and non-secret installed Node/worker/configuration identity are frozen.
A later Run opens a fresh environment; a lost heap is unavailable, never reconstructed by replaying
cell source. An optional cell timeout is an explicit caller budget.

A single owning `ToolSchema.requirements` declaration projects source/physical/live and process
dependencies through directory discovery, child preparation and source grants. Script-only selection
does not require selecting an unrelated process or file tool. Requirements are not permissions.
Source-absent and fixed-branch-only work cannot manufacture a Host cwd. Automatic discovery projects
original dependency availability; explicit required incompatible bindings fail actionably. Rust
retains final frozen-launch validity and dispatch authority.

Catalog **47** records the original Operation and typed managed-process purpose, not another process
registry. Storage process records and the original guardian alone own actual process/tree identity,
interaction receipts, output and writer activity. Process controls obtain Run identity from the
original authorized grant. Public terminals expose ordinary ProcessJobs, not private Node frames.
Kernel wire **2** is distinct from version 1 of the private Host-tool and Node-worker envelopes.
Older internal formats are rejected directly; external assets are not migrated.

The shared [Node evaluator](../../packages/script-runtime/README.md) uses public `node:repl` and
AsyncLocalStorage. Node owns lexical declarations, classes, closures, objects, top-level await and
returned Promises. Saved functions use their actual new caller's scope; detached old continuations
retain a closed old scope. Evaluation fences new calls before draining already accepted calls,
including unawaited calls and calls preceding an outer error. `tools.invoke` keeps the original
frozen directory, exact nested ID, permission, source, cancellation and receipt. Memory facts reach
the next original RequestView without needing an echoed receipt or unsolicited provider pairing.

Idle environments remain potential writers. Physical guardian termination and actual accepted Host
callback drain are separate evidence; an environment settles only when both are established.
Exact cell cancellation reaches the original graph-node token, without cancelling siblings. Run
completion stops Run-owned environments; independently accepted Thread ProcessJobs retain their
original lifetime. Closing an environment does not stop such independent Jobs.

An ordinary close receipt describes its own completed control request. Any unconfirmed physical
writer remains on the original environment Operation, not a duplicate Unknown on the close call.
Lost terminal responses reconcile that same original receipt. A new Host/epoch or empty map cannot
prove old callbacks ended, and does not authorize heap replay.

Computer cancellation hooks are attached only to genuinely admitted current calls and removed when
those calls end. Environment closure starts original Computer interruption and guardian termination
before waiting for callback drain. Desktop Stop identifies the current environment and desktop;
unrelated environments remain independent. A self-cancel against the same active ancestor is a real
wait cycle and returns an actionable diagnostic. Physical desktop release still belongs to the
original Computer owner, not the evaluator's abort flag.

## Shared Pi evaluator

The existing Pi Worker imports the same evaluator with its original Computer SDK install hook,
error facts and image callbacks. It does not acquire Native tools or impersonate a Native scope.
Reset fences the generation and starts actual Worker termination, then waits for Worker exit and
already accepted callbacks. Unexpected Worker loss requests original bridge cancellation before
waiting for those callbacks. Existing reset and session cancel consumers now await this lifecycle.
Pi callback/Worker tests do not establish physical desktop release.

## Original-owner integration evidence

The repository driver is `kernel/crates/varin-kernel/src/managed_script_review.rs`, with the Host
helper `packages/web/application-host/lib/kernel/managed-script-host.test-helper.ts`. It uses actual
RunSupervisor, Engine, policy graph, RunTools, ToolBridge, Catalog, source grant, Storage, process
interaction/subscription owner, a freshly built guardian binary, Host ScriptRuntime and managed Node.
Actual MemoryTools reach the original Host MemoryBridge/MemoryOwner/AgentPersonalization.

Only the provider response, installed binding/permission fixture, Documents root discovery and
MemoryOwner's atomic record backend are controlled. Stdin/stdout is a test transport seam, not a
replacement product IPC implementation. Original ControlCommands and Run-ended shutdown are called,
so the tests do not omit the independent Catalog-to-guardian stop path.

The finite scenarios cover lexical persistence plus actual source writes; nested memory commit then
outer failure and next-request delivery; lost terminal response without replay; a synchronous Node
loop whose tree stops while its original Host callback is deliberately held; and Run-end closure
while a real independent nested ProcessJob remains alive and later finishes.

Actual cross-owner failures were corrected before these traces passed:

- Exact policy-node Stop did not reach its running cell token. The original graph-node token is now
  aliased into the existing Run cancellation index; no broader Run cancellation was substituted.
- Host-spawned process controls lacked Run attribution because Storage read an internal parameter
  supplied only by the other caller. Storage now uses the original authorized grant; the redundant
  internal parameter and its producers were removed.

A further original child-guardian regression exposed a legitimate fixed-source parent delegating an
isolated writable child being rejected while the ChildTask still retained the parent handoff.
Named child-intent stage/read validate structure during that existing Pending state. After original
ChildSource Ready, the actual Run submission still performs full source-dependency validation.
Ordinary launch validation is unchanged. The original failure passes without changing the parent
source. That next trace also exposed old hand-driven process fixtures omitting the shared runner's
new typed association step; those fixtures now obtain it from the original BoundToolCall and persist
it in the original dispatch order. Product writer checks were not weakened.

Independent review also reproduced a warm-provider discovery failure: after a physical Run used
scripts, a new source-absent/fixed Run inherited incompatible already-active bindings and its whole
launch failed. The original source now reaches the preparer; the same declaration-based availability
projection handles warm, cold, dynamic and explicitly required bindings, before final Rust validation. A separately reproduced bad Node binding now makes only its own
script descriptors unavailable; an unrelated ordinary tool can still prepare. Explicit required
script configuration remains an actionable failure.

A separate installed-artifact probe uses a fresh ApplicationExtensionRuntime and the real compiled
scripts manifest/host entry. Cold service request, ArtifactStore retention, broker and SDK route all
three schemas and original invocation identities into `scripts.execute`. Its endpoint is a capture
handler; that probe is installation/routing evidence, complementary to the real Node lifecycle driver.

## Verification scope

- Final runtime library/integration execution: **459 passed, 2 ignored, 7 socket-dependent cases
  explicitly excluded**, across 37 execution targets plus empty doc tests. The exclusions are the
  original five provider HTTP/SSE tests and the two HTTP credential/model factory tests.
- Kernel library: **150 passed / 17 ignored**. The explicitly invoked original managed Node five,
  child guardian one and process/follow-up two all passed on the final built binary. The 28 focused
  child dispatch/delegation/source tests also cover Pending projections and reject premature Run
  preparation while preserving full ordinary fixed-source validation.
- Shared evaluator **17** and Pi original consumers **20** pass; Pi build/full type checks and focused
  lint pass. The independent reviewer separately exercised Pi falsy-error and scope boundaries.
- Host source/configuration, installed-owner and original preparer consumers **14**, packaging
  architecture/manifest consumers **9**, and cloud layout **12** pass. Existing Host cancellation,
  Computer and terminal consumers pass in their stated bounded suites. Independent probes establish
  actual warm/cold/required behavior and the new scripts artifact's broker route, not physical desktop
  execution. The final UI projection one and calendar-owner four pass after their public frame
  fixtures consume the generated wire version instead of stale version 1.
- Generated protocol check, Host production/test types, full UI/Pi types and changed-source lint pass.
  The actual Host bundle has **546 reachable modules**, excluding **80 legacy/test artifacts**.
  Linux x64 ELF staging records identity **0.9.25**, wire **2**, SHA-256
  `450826ba9f069eaddedcdc622d2f996eae49c05ed628964923b0c8c0be18dc6e`.
- The frozen source-input manifest covers **4,947** non-documentation tracked/unignored kernel,
  package, script and example inputs plus root build configuration, SHA-256
  `b64ecd4a0a921a74bce4b21ac9a06a0ba086da662de68f1816fdb1fec0d820c3`.
  It is rechecked after final verification. This records source identity, not performance or platform
  equivalence. Kernel builds retain the same 14 existing warnings.

Independent review accepts this finite slice with no remaining confirmed release blocker. Its
acceptance was derived from both designs before implementation review; the original failed probes
were rerun after repair. The rejected kill/pending-hang hypothesis is not presented as a product bug:
complete original control routing stopped the tree, and the distinct repeat-close error was the real
finding. Engineering documentation checks **229 files / 1,750 local links / no errors**.

## Known boundaries and reproduction

On tested Node **24.19.0**, public REPL evaluation of `await Promise.reject(null)` gives the same
`(null, undefined)` callback as a successful undefined result. The direct upstream probe and package
README preserve that limitation. Other tested falsy throws/rejections remain errors. This change does
not fork the parser, rewrite source or patch global Promise. Node **>=22.19.0** remains the existing
product engine range; Node 22 was not separately run. Raw stdout bypassing the provided console can
corrupt the private frame stream. General Node I/O is not an OS sandbox.

With built workspace packages and the matching kernel binary, representative entry points are:

```sh
bun run --cwd packages/script-runtime test
node --experimental-repl-await packages/script-runtime/test/repl-null-rejection-probe.mjs
node --import tsx --test packages/pi-host/test/harness/computer-tools.test.ts \
  packages/pi-host/test/harness/computer-repl.test.ts
VARIN_TEST_KERNEL_EXECUTABLE="$PWD/kernel/target/debug/varin-kernel" \
  cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib managed_script_review \
  -- --ignored --nocapture --test-threads=1
```

The ignored cross-owner tests require serial execution because the kill-refusal case uses the
existing process fault-injection setting around one original Storage dispatch. The known denied
socket-listen capability was not retried or bypassed. Earlier Windows acceptance remains evidence
for its own baseline. Child ScriptEnvironment-to-fixed-result publication was checked through its original generic
writer/Ready barriers and the separate child guardian regression, not a full child-script execution.
Full product/platform/performance acceptance and the two designs' remaining
capabilities are separate from this slice; final migration remains the user's responsibility.
