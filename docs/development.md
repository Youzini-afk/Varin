# Varin engineering guide

This document is the entry point for contributors and coding agents. It describes where current
project knowledge lives and how to choose useful verification without turning every change into the
same fixed ceremony.

## Sources of truth

Varin uses a docs-first repository model rather than repository-local workflow Skills:

1. Code, types, schemas, tests, and `package.json` scripts define executable behavior.
2. The nearest package or module `README.md` / `DOCUMENTATION.md` records local ownership and
   non-obvious invariants.
3. Documents under `docs/` describe product-wide architecture, delivered designs, migration decisions,
   security, and operations; [docs/README.md](README.md) indexes them by status (current authority,
   design, or archived history).
4. `AGENTS.md` contains only the small set of cross-project boundaries that should remain stable.

Examples and historical plans are evidence, not commands. When a document disagrees with current code,
check callers and recent commits rather than preserving both interpretations. Update the stale document
or implementation in the same coherent change.

## Knowledge map

| Area | Current authority |
| --- | --- |
| Product/process/data architecture | [architecture.md](architecture.md) |
| Varin naming and distribution cutover | [varin-rebrand-design.md](design/varin-rebrand-design.md), Stage B in the harness plan; source/repository implemented, first publication tracked in status |
| Agent harness contract, plan, status, decision log | [agent-harness.md](design/agent-harness.md), [agent-harness-plan.md](plan/agent-harness-plan.md), [status.md](status.md), [decisions/README.md](decisions/README.md) |
| Task/resource Harness and continuous retrieval (D-337, implemented HR0–HR5) | [resource-oriented-harness-design.md](design/resource-oriented-harness-design.md): project-independent sessions/resources, per-operation paths, resource/version indexes; replaced the RR2 work-context and related RR4 ownership targets — per-scenario evidence in [status.md](status.md) |
| Agent runtime reliability (RR, existing implementation and validation record) | [agent-runtime-reliability-plan.md](plan/agent-runtime-reliability-plan.md): live-session recovery and cancellation, shell/output reliability, retrieval evidence, and proxy-aware networking; directory-model replacement is specified by D-337 |
| Background compaction Agent (D-314, wired) | [context-compaction-agent-design.md](design/context-compaction-agent-design.md); Stage C in the harness plan |
| Web and scholarly search (D-315, L0/L2 initial slices wired) | [web-research-search-design.md](design/web-research-search-design.md); Stage L in the harness plan; reuses existing retrieval/investigation threads |
| Office and daily work continuity (D-327, design accepted / not implemented) | [office-work-continuity-design.md](design/office-work-continuity-design.md); future O0–O4 delivery stages; reuses existing workbench, Thread/Run, materials, artifacts, follow-up, and Rust authorities |
| Rust system kernel | [rust-kernel-design.md](design/rust-kernel-design.md), [rust-kernel-audit.md](plan/rust-kernel-audit.md), [kernel/README.md](../kernel/README.md) |
| OpenChamber source and non-regression boundary | [openchamber-pi-migration.md](ops/openchamber-pi-migration.md) |
| Workbench profiles and extension composition | [composable-workbench.md](design/composable-workbench.md) |
| Documents, Monaco, mobile adapters, language services | [unified-file-editor-platform.md](design/unified-file-editor-platform.md) and the module docs under `packages/ui/src/lib` |
| Varin extension platform | [varin-extension-platform.md](design/varin-extension-platform.md) and [varin-extension-authoring.md](ops/varin-extension-authoring.md) |
| Shared UI, themes, localization, settings, interactions | [packages/ui/DOCUMENTATION.md](../packages/ui/DOCUMENTATION.md) |
| Shared runtime APIs, authenticated URLs, runtime switching | [packages/application-client/README.md](../packages/application-client/README.md) and [packages/ui/src/lib/api/DOCUMENTATION.md](../packages/ui/src/lib/api/DOCUMENTATION.md) |
| UI stores, synchronization, cache identity, visible-demand work | [packages/ui/src/stores/DOCUMENTATION.md](../packages/ui/src/stores/DOCUMENTATION.md) |
| Electron ownership, packaging, signing, smoke checks | [packages/electron/README.md](../packages/electron/README.md) |
| Web CLI commands and output modes | [packages/web/cli/lib/DOCUMENTATION.md](../packages/web/cli/lib/DOCUMENTATION.md) |
| Relay transport and wire compatibility | [packages/web/application-host/lib/relay/DOCUMENTATION.md](../packages/web/application-host/lib/relay/DOCUMENTATION.md) |
| Mobile builds and iOS Simulator scripts | [packages/mobile/README.md](../packages/mobile/README.md) |
| Cloud deployment and container contract | [cloud-deployment.md](ops/cloud-deployment.md) |
| Security model | [security.md](design/security.md) |

## Working on a change

Begin at the owner rather than at a universal checklist:

- Read the nearest module documentation and the code paths that consume the behavior.
- Identify the real authority: renderer view state, application-host data, Pi runtime state, plugin-owned
  configuration, or persistent Varin metadata.
- Keep failure distinguishable from successful empty state, and reject stale asynchronous work at the
  owner boundary when that lifecycle applies.
- Prefer an existing primitive, contract, or script when it already expresses the behavior. Do not
  preserve obsolete alternatives merely because they once existed.

Verification should answer a concrete regression question:

| Change shape | Evidence that usually changes the decision |
| --- | --- |
| Documentation only | Link/status validation and the relevant documentation test |
| Local implementation | Existing direct behavior coverage where useful; type/lint checks when static shape changed. Small presentation edits need no automatic new test. |
| Shared contract or persisted schema | Actual consumers and the changed data behavior; type checking already covers static shape. Test distinct failure consequences rather than mirroring DTOs. |
| Platform, process, packaging, or native behavior | The relevant bundled, packaged, or platform smoke; static checks alone do not prove it |
| Performance work | A representative reproduction and measurement of the reported interaction, plus correctness coverage for the structural change |

Run a broader suite when it can expose a different class of failure, not merely because it exists.
Avoid repeating a successful expensive check after changes that cannot affect it. Report important
coverage gaps instead of converting them into a false pass.

Stage Q, specified in [testing-ci-design.md](design/testing-ci-design.md) and the
[harness implementation plan](plan/agent-harness-plan.md), is the completed engineering phase before the
AI4S implementation stage. It reassessed test responsibilities, fixtures, discovery, repeated
builds and CI execution across the repository. The 2026-09-21 follow-up removes source-text, type-literal,
retired migration and release-layout checks that remained after Q; the dispositions are recorded in
[the audit addendum](archive/testing-ci-audit.md#11-test-content-reduction-2026-09-21). Current scripts remain the
command authority. Do not turn cleanup into a checklist for every change or replace every deleted
assertion with a new test. Prefer fewer tests that exercise distinct product behavior.

## Companion retirement and current AI4S stage

D-296 retires the former VS Code companion before AI4S. The implementation removes the companion
package, development/build/packaging entrypoints, companion-only shared surface contracts, and current
installation or marketplace guidance. No archived compatibility copy is kept. The documentation and
implementation are complete, and the root build plus built-server knowledge smoke passed locally.
Packaged, cross-platform, and remote-CI evidence remains outside that local result. AI4S phase 7A now
implements the research workbench, independent work focus and real root Thread/Run attachment. Follow
the phase 7 plan and current harness status for subsequent capability routing and experiment delivery.

## Repository and build facts

- The workspace uses Bun `1.3.14`; root and package `package.json` scripts are the command authority.
- The private Rust kernel lives in `kernel/`; use `bun run kernel:check` for a fast compile check and
  `bun run kernel:build` to produce the release executable. Host/desktop packaging stages that binary
  outside `app.asar`; a source-development Host may use the Cargo runner only when explicitly allowed,
  while every production/Web/cloud/Electron layout requires its manifest-verified staged executable.
  `bun run test:kernel` is the non-skipping native authority suite; `scripts/smoke-kernel-release.mjs`
  validates the emitted release boundary, and `scripts/measure-kernel.mjs` owns the reproducible R6
  subsystem measurement rather than an informal microbenchmark. Kernel-dependent Vitest files run only
  through `packages/web/vitest.kernel.config.ts` under that entry; the main `packages/web` suite excludes
  them and stays deterministic without Rust artifacts.
  Electron splits `test:runtime` from the dedicated `test:updater`/`test:linux-desktop` vitest files.
- `bun.lock` covers development. `scripts/cloud-runtime.bun.lock` separately pins the production cloud
  runtime graph; dependency changes that reach it need `bun run update:cloud-runtime-lock`.
- `@varin/ui` runs under Vitest as part of `bun run test:pi`.
- Electron's `type-check` covers both `tsconfig.json` (product) and `tsconfig.tests.json` (tests).
  `bun run type-check:electron` prepares workspace type dependencies and emits current Application Host
  declarations into a type-only generated directory; it does not replace a running/locked `server/` runtime.
  `bun run lint:electron` checks all `./packages/electron/*.ts` against the shared ESLint config
  with zero expected errors. Desktop startup, preload, process, native-module, and packaging claims
  still require Electron tests or an actual smoke.
- The 58 `desktop_*` IPC commands, preload bootstrap payload, desktop events, and shared DTOs are
  typed in `packages/application-client/src/desktop.ts` — the single framework-neutral contract
  consumed by Electron main, preload, and the UI. Runtime contract tests protect command recognition
  and the remote-safe subset. Source language
  and compiler/lint policy are not duplicated in a separate architecture test.
- Engineering docs are checked by `bun run test:docs`; public docs-site content is checked by
  `bun run docs:validate`.
- Adding or removing source/export shapes may warrant `bun run dead-code`, but its output is diagnostic:
  inspect whether findings are introduced by the change rather than treating every pre-existing entry
  as part of the task.

## Git discipline

Do not reset, clean, or overwrite unrelated work. Inspect status before editing and keep coherent
phases separately reviewable. Completed repository phases are committed and pushed; external releases,
publishing, deployment, and credential changes still require the authority given by the current task.
