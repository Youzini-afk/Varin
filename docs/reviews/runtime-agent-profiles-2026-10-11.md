# Runtime-specific Agent profiles and the real settings consumer

Date: 2026-10-11. Baseline: `3dcd65ac0ab388b4f45889817dc3c9ce8ac63b87`.

This slice addresses the preset/settings gap left by the maintainer's
[integration acceptance](runtime-2026-10-11.md). It does not complete both runtime designs.
The maintainer's Windows Host → IPC → Rust **78-pass** result belongs to that baseline;
the evidence below is the new slice's Linux and controlled-consumer verification.

## One configuration and declaration authority

The original global `settings.json` remains the profile authority. Its existing `tools`
field accepts either the original user array or `{ pi?: string[], agent?: string[] }`.
An original array is an explicit selection for both runtimes, without aliasing Pi names
to Agent names. Reading never rewrites it. An explicit edit preserves the other runtime;
an explicit empty array means no tools, while a missing custom runtime key means
unconfigured. Removing a built-in runtime override restores that runtime's defaults.
Shared names, instructions, models, enabled state and worktree settings remain visibly
shared. Deleting a custom profile removes it from both runtimes.

The actual Rust owning tool declarations now carry worker/retrieval default membership
beside their source requirement. The original built-in directory projects both metadata
and executable schemas from those declarations. Host configuration and child preparation
consume that directory, rather than maintaining another Native tool-name list. Pi retains
its own shipped defaults. A global directory preview cannot establish availability of an
extension/MCP binding in a particular Run, so the settings page says configured; the
original frozen child selection still reports actual unsupported/source/model failures.

The existing SettingsManager, revisioned file editor and validation transaction are shared
by Pi settings and the independent profile API. No Pi session is created to edit Agent
profiles. The authenticated Host routes and framework-neutral `AgentProfilesAPI` serve
the shared UI on all existing surfaces. Runtime switching in this editor selects which
tools to edit; it does not switch any conversation's runtime.

The settings page selects actual native models through `ThreadsAPI`, keeps Pi plugin
providers on the Pi side, and initializes a new custom profile from the selected runtime's
retrieval defaults. A missing other-runtime selection is not silently filled. Drafts retain
their original revision through conflicts and reject late responses after Host/runtime/
selection changes. Typed errors retain useful recovery actions without upstream secrets.

## Admission, cancellation and recovery

The existing Host child compiler freezes concrete choices into `ChildDispatchCatalog`.
Normal parent-tool inheritance and an explicitly configured preset retain their distinct
existing authorization contracts. No new inspection channel, delegation list, grant or
configuration database was introduced. A child accepted before later settings edits keeps
its original model, instructions, tools and source after restart. Invalid future settings
do not prevent reading the already accepted receipt. The added persisted declaration
metadata changes Catalog **39 → 40**; old internal formats are rejected before epoch
mutation. External settings and their legacy profile normalization remain user assets.

Independent review and lead integration also checked consumers outside the new UI:

- Existing normalized legacy profiles are editable/removable using that same normalized
  base, rather than reading one identity and attempting to save a different raw identity.
- External profile CAS saves do not replace an in-flight Pi exchange. At the existing safe
  settled/prompt boundaries, the live SessionHost detects the file revision and reloads
  through its original owner. A concurrent newer revision remains detectable. A real old
  SDK setting setter/flush does not overwrite the newer profile document.
- Manual compaction registers its original stoppable activity before awaiting a pending
  reload. Stop during that wait is accepted and prevents compaction dispatch; no new
  cancellation owner or worker-termination fallback was added.

## Verification and its limits

- Runtime **436 passed / 0 failed / 2 ignored** and kernel **142 passed / 0 failed /
  11 ignored** in one locked suite. Two subsequent Rust-only cleanups reused the original
  question schema projection and test-only import; the final owning capability tests
  **5/5**, all-targets check and fresh binary build passed after those changes.
- Protocol/Pi **22/22**, including actual SessionHost A → external CAS B → next prompt B,
  preservation through an old SDK setter/flush, and cancellation while reload is held.
- Host owner/compiler and registered route/client **7/7**; application-client **2/2**;
  shared UI **26/26** across seven files. The five settings-page cases include actual
  temporary settings files, Host service and HTTP client through controlled fetch, then
  React interactions. Final presentation-only changes received focused verification.
- Independent outside-repository probes used the actual settings CAS/API, child compiler
  and `ThreadAdapter.submit`, then fed its captured child-dispatch catalog and parent model
  binding into the final runtime library. The Catalog probe intentionally used empty
  parent tools and no source; it did not replay a complete executable launch.
  Six original Catalog selections, cancellation/late binding and reopen preservation
  passed. They also checked explicit arrays, empty/missing runtime selections, conflict,
  directory failure secrecy and reuse of the original receipt after bad settings.
  Directory descriptors and the submit transport were controlled; this does not establish
  real IPC, grants or complete child execution.
- A separate independent Pi consumer probe saved B through the actual new Agent profile
  API, then C through its Pi selection while an A request was held. Reading the active
  system prompt did not reload A; an old SDK setter/flush preserved both runtime choices,
  and the next actual faux-provider request used C. No paid provider or Pi child dispatch
  was involved. Independent review accepted this slice without a confirmed remaining
  behavior blocker.
- Host/Pi/UI source and relevant test types, changed-file lint, generated protocol and
  production Host build passed. The build retained **538 reachable / 72 excluded** modules.

Fresh Linux x64 `0.9.25` kernel binary SHA-256:
`e691848778f43591ac28d3f577aa9e2756f035e3e3b5fb080ab43eade4a0b0f3`.
Its existing real guardian/tree-stop/fixed-result combination passed **1/1** using that
exact executable. This is a real process/Storage regression check, not the complete Host
profile-to-child path. Two initial exact filters matched zero tests and were not counted;
the fully qualified test name then ran the actual case.

The real Host native review now uses the new profile API for default retrieval, default
worker private writes, and custom A → later B → accepted-child restart. These cases were
type-checked but **not executed here**: this cloud environment rejects Unix IPC listen.
The `tsx` CLI also encountered its own auxiliary-pipe restriction before a probe started;
the same socket-free probe ran with Node's supported `--import tsx` loader. Product
transport was not changed. No live paid model, browser acceptance, remote job, cross-platform
or performance result is claimed by this slice.

## Reproduce

Use the locked tools in [development](../development.md), from the repository root:

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime -p varin-kernel --locked -- --test-threads=2
cargo check --manifest-path kernel/Cargo.toml -p varin-runtime -p varin-kernel --all-targets --locked
node --import tsx --test packages/protocol/test/harness-model-slots.test.ts \
  packages/pi-host/test/profile-settings-boundary.test.ts \
  packages/pi-host/test/session-host-prompt.test.ts
(cd packages/web && bun x vitest run \
  application-host/lib/kernel/child-profiles.test.ts \
  application-host/lib/kernel/agent-profile-routes.test.ts)
(cd packages/ui && bun x vitest run src/components/sections/agents/AgentsPage.behavior.test.tsx)
node scripts/generate-kernel-protocol.mjs --check
bun run --cwd packages/web build:application-host
```

In an environment supporting the actual kernel transport, run `bun run test:kernel`,
including `child-dispatch-review.native.test.ts`. The portable probes above are deliberately
not a replacement for that lane. They were chosen to exercise the cross-owner failures
found by acceptance, rather than treating separately green modules as complete integration.

## Continuation

Continue durable log literal/log-end conditions and their real source consumer, then the
remaining domain/composition capabilities of both designs. Computer/handoff/remote,
Web/material/PDF/scholarly/Bot, MCP resources/prompts/Tasks, durable scripts, and the
SourceView/retrieval/context/provider long tail remain incomplete. Generic preparation
failure projection outside this profile API also needs its own real consumer slice.
Full Host/product/platform/performance acceptance remains distinct from implementation.
The user performs final default-runtime cutover, Pi removal and asset migration after
acceptance; none is performed by this phase.
