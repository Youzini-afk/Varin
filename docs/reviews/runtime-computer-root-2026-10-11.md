# Native root Computer calls and original physical ownership

Date: 2026-10-11. Baseline: `a65c8593b52cb294a4c6fdc427c0db9e560d8beb`.
Status: finite implementation slice accepted after independent owner/consumer review; full IPC and
platform acceptance remain unrun here.

This finite slice connects native root single-call Computer tools and their real public consumers to
the existing desktop owner. It follows runtime design §19 and the extension design's shared physical
resource contract. Native child assignment requests/Wait, trusted environment and handback inputs,
persistent Computer scripts, and remaining environment capabilities are separate unfinished work.

## One call path and one physical owner

The shipped `varin.builtin.computer` uses ordinary SDK `provideTool`, immutable artifact selection,
reviewed `computer.use` capability and original ToolInvocationAuthority. Shared declarations provide
the tool schema and Host decoder; no second tool or permission list was added. Real ModelStep and
PolicyAction calls require their original running external Operation. File-source-less roots work;
child discovery does not imply a desktop assignment. Current global/trusted-project settings can
disable dispatch, while the original saved binding freezes the selected default desktop for a Run.

Rust projects the original Thread/branch/family and branch's active Run. Context/auxiliary Runs cannot
become the current work by being newer. Protocol work/execution identities distinguish native and Pi;
idle work has no invented Run. The same ComputerService, input lane, observations and desktop
assignment coordinate both runtimes, human control and remote claims.

The original desktop record's version-2 runtime metadata persists its physical input owner before
dispatch. Replacement Host/helper generations, empty peer maps and readiness probes cannot acknowledge
old held input. Actual release and callback drainage remain separate from action effects and durable
record clearing. A failed clear retains both the barrier and the original release proof for retry.
Unsupported or malformed internal runtime records are explicit failures; external assets are retained.

## Actual public consumers and cleanup

Native `ThreadsAPI.computer` passes through the authenticated registered Host routes. Conversation Stop
captures original work/Run; desktop Stop captures the real target's control epoch and does not ask a
viewing Host to resolve a foreign actor locally. Known accepted cleanup starts before a potentially
slow Catalog projection. Native Run termination also reconciles accepted Computer work through the
original owner; a channel reset or changed extension binding is not completion evidence.

The shared overview, native conversation and desktop viewer distinguish current work from unresolved
old cleanup. HTTP and SSE use protocol parsers. Captured Host/work/Run/control revisions fence late
responses, including takeover and handback. Bounded errors retain actionable recovery information;
missing owners and old physical uncertainty are not presented as successful empty state.

## Confirmed integration failures corrected during development

- A known accepted Stop waited for a new Native scope projection before physical release. The original
  held-projection probe failed before the correction and passed afterward.
- An input supervisor silently spawned another helper under the same owner wrapper after its original
  process exited. A real Node subprocess probe failed before the correction and passed afterward.
  An explicit new helper has a new owner; independent capture restart remains available.
- Delayed takeover/handback responses overwrote newer `cancel-unconfirmed` SSE state. Two independent
  DOM/transport probes failed, then passed unchanged using the existing control-revision fence.
- Native natural Run completion lacked the original assignment cleanup consumer. A manually stopped
  fixture did not cover this path; terminal cleanup was added to the actual runtime lifecycle.
- A single obsolete desktop runtime record made the production handback-aware catalog read and all
  healthy work snapshots fail. The original service probe reproduced this cross-desktop failure;
  the unchanged probe now passes with that record explicitly unavailable and independent records
  still visible. Failed Storage reads remain errors and can be retried by the next actual request.
- Eager default-desktop configuration reading blocked all ordinary extension preparation when the
  Computer setting was malformed, even for unrelated tools. A direct owner probe reproduced this;
  the unchanged probe and an independent real-file/broker test now pass. Configuration failure belongs
  to the actual Computer candidate; exact saved bindings remain strict without another desktop fallback.

Additional owner checks cover exact admission tickets after Stop/regrant, release proof surviving a
failed durable clear, old peer/human markers after Host restart, and unknown effect remaining unknown
after a separately confirmed input stop. No real physical desktop was used for those checks.

## Verification and reproduction

Independent review found no remaining confirmed blocker in this finite slice. Its decisive checks used
the actual shipped Computer manifest/`host.cjs`, ApplicationExtensionRuntime broker process,
createExtensionTools and ToolBridge through the original ComputerService. Both real call-origin shapes
retained their original effects and stop facts. The Catalog management-query port and physical driver
were explicitly controlled; this was not Rust IPC or desktop hardware execution.

Separately, the actual HTTP client reached Express's registered authentication/Thread routes and the
original Computer owner using an in-memory request/response transport. Authentication rejection, stale
Run rejection and exact Stop were observed. This establishes the consumer path without claiming a
real HTTP socket. Natural completed/failed/cancelled facts each drained accepted work without a prior
manual Stop. The original ToolBridge reset/reconnect retained the old callback until actual drain,
then delivered its unknown/stopped receipt under the new channel epoch without repeating input.

The independent marker checks also covered failed publication before input, same-Host-ID restart,
replacement helpers, all original admission paths, failed durable clearing and retry using the same
release proof. The earlier four slow-dependency emergency-stop sequences were rerun after the identity
change. Active shipped Computer plus a separately installed ordinary SDK tool verified that a damaged
real default file leaves only Computer candidates unavailable; the independent broker call still ran.

Other focused evidence:

- Rust Catalog scope tests **2 passed**; kernel **all-targets check** and a fresh release build passed.
  These cover original ModelStep/PolicyAction dispatch, source-less work and active-branch versus
  auxiliary-Run identity. The release retained 14 existing warnings outside this change.
- Original Computer/Pi owners and actual Node helper supervisor: **108 passed, 4 skipped**. One is the
  explicitly excluded real-socket remote-Host case; three are Windows-only driver cases. Native
  owner/invocation seams: **22 passed** with controlled Storage, Catalog query and driver ports.
- Shared extension/integration/schedule/ToolBridge regressions: **15 passed** before the final isolated
  configuration correction; its affected real extension-owner file then passed **2 tests** again.
  Research receipt consumers passed **5** and the corrected existing Bot lifecycle fixtures **4**.
- Application-client **9 passed**. Seven UI files passed **100 tests** before the late-control-reply
  correction; the affected desktop file then passed **5**, and the unchanged independent two-case
  takeover/handback probe passed. These are consumer/DOM checks, not physical release evidence.
- Final Host production and complete Host-test types, client/UI types, changed-source lint, generated
  protocol, whitespace and documentation checks passed. The actual Host bundle has **544 reachable
  modules / 72 excluded legacy or test artifacts**. The original builtins build produced the real
  immutable Computer package, not a test-only substitute.

The final **5,241** tracked/unignored kernel/package/script inputs excluding Markdown have manifest
SHA-256 `388f69b42fc6d525afe233c3d02ad54c7295c47962a5ae65e119d121a6603bac`.
The staged Linux x64 kernel, build identity `0.9.25`, has SHA-256
`f9c3cda80e4350281437b82599693856ae4ef0fcf6efc6caccc664b3b7c38554`.
The Computer distribution fingerprint is
`sha256-c80a97aceec478b9a6ed8236ec3df690f385e04f16572f02792d434ba25bcac0`.

From the repository root with the locked development tools:

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --lib computer_scope
node --import tsx --test \
  packages/web/application-host/lib/kernel/computer-runtime.test.ts \
  packages/web/application-host/lib/kernel/tool-invocation.test.ts
node node_modules/vitest/vitest.mjs run --config packages/web/vitest.config.ts \
  packages/web/application-host/lib/computer/computer-service.test.ts \
  packages/web/application-host/lib/computer/driver-host.test.ts \
  packages/web/application-host/lib/computer/computer-actor.test.ts \
  packages/web/application-host/lib/computer/computer-automation.test.ts \
  packages/web/application-host/lib/harness/environment-services.test.ts \
  --maxWorkers=2 -t '^(?!.*enforces assignments on the actual remote Host).*'
bun run --cwd packages/web type-check:application-host:raw
bun run --cwd packages/extension-builtins build
bun run --cwd packages/web build:application-host
```

The full native acceptance fixture is
`packages/web/application-host/lib/kernel/computer-review.native.test.ts`. It exercises the
real HTTP client/registered route, kernel IPC, shipped extension and original ComputerService with a
controlled driver and local fixed provider, then natural terminal cleanup, content GC and reopen.
It has not been executed in this cloud because socket listening is unavailable. Do not treat its
presence, type checking or the maintainer's earlier Windows IPC acceptance as a pass on this revision.

For an environment supporting local HTTP and kernel IPC, build the original packages and kernel using
the repository scripts before running that fixture:

```sh
bun run kernel:build
node scripts/test-kernel-authority.mjs \
  --vitest-file=packages/web/application-host/lib/kernel/computer-review.native.test.ts
```

It does not use a real desktop or paid model. Its distribution-managed builtin setup was corrected
using the independently executed package path; the complete fixture remains unrun.
Actual Windows/Linux/macOS input, remote Hosts, VM lifecycle, installed-product behavior and complete
two-design performance acceptance remain separate verification work.

The user still owns final default-runtime cutover, Pi removal and broad asset migration after acceptance.
