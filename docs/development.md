# Varin development guide

Start here when changing the repository. [Architecture](architecture.md) explains the system;
[the documentation index](README.md) routes domain questions; [AGENTS.md](../AGENTS.md) keeps the
cross-project contribution and trust boundaries.

## Sources of truth

Code, types, schemas, tests and package scripts define executable behavior. The nearest module
`README.md` or `DOCUMENTATION.md` explains its owner and non-obvious invariants. Cross-cutting contracts
live in [design](design/README.md), implementation work in [plans](plan/README.md), and recorded
verification in [reviews](reviews/README.md). Historical plans and decisions explain earlier choices,
not a second current implementation.

When these disagree, inspect the callers and relevant commits, then update the responsible document or
implementation. Use [status](status.md) for delivery boundaries rather than inferring them from an old
phase heading. The repository uses ordinary documentation, not project-local workflow Skills.

## Start a development environment

The source-development baseline is Node.js 24, Bun as pinned by the root `packageManager`, Git, and
the Rust toolchain selected by [kernel/rust-toolchain.toml](../kernel/rust-toolchain.toml).
The Pi Host and packaged runtime have their own minimum engine declarations. Windows shell use also
needs the supported shell installation described in the [project README](../README.md#get-started-from-source).

```bash
bun install --frozen-lockfile
bun run dev
```

`dev` starts the Web UI and trusted API/runtime service, printing the selected local URLs.
For Electron use `bun run electron:dev`; `bun run electron:dev:bundled` exercises bundled UI assets.
See [Web](../packages/web/README.md), [Electron](../packages/electron/README.md), and
[mobile](../packages/mobile/README.md) for platform-specific setup. This guide does not duplicate their
packaging, signing or device instructions.

## Knowledge map

The [domain-to-owner map](README.md#按领域找实现) is the shared navigation table. A typical change starts
at the owning module and follows its actual consumers, not by reading every design or historical stage.
[Protocol](../packages/protocol/README.md) and [application-client](../packages/application-client/README.md)
are the cross-package contract entry points; [Host harness](../packages/web/application-host/lib/harness/DOCUMENTATION.md)
and [Pi harness](../packages/pi-host/src/harness/README.md) explain the runtime split.

## Working on a change

Identify the authoritative state and the request path that changes it. Renderer state, Host services,
Pi history, extension configuration and Rust-owned resources are distinct owners. Preserve unrelated
work, meaningful failure states and the existing resource/lifecycle boundaries.

Choose verification by the failure a change could introduce:

| Change | Useful evidence |
| --- | --- |
| Documentation or navigation | Local-path and public-route checks; review changed facts and section links |
| Local implementation | Focused behavior tests; type/lint checks when the static shape changes |
| Shared contract or persistence | Actual consumers and changed data behavior, not literal DTO snapshots |
| Processes, native code, packaging or platform behavior | Relevant native suite, installed-runtime check or platform smoke |
| Performance | Representative reproduction and measurement, plus correctness coverage for the changed path |

Broaden a check when it can expose a different failure class. Do not add a test automatically for every
wording, presentation or type edit, or repeat an expensive successful build after an unrelated change.
A simulated provider can establish request wiring; it does not establish model quality or latency.
[Test design](design/testing-ci-design.md) explains the repository's evidence model; historical cleanup
results live in the [testing audit](archive/testing-ci-audit.md).

## Repository and build facts

The nearest `package.json` is the command authority. The following root entries are navigation, not a
requirement to run every command on every change.

| Purpose | Root command |
| --- | --- |
| Prepare shared type dependencies | `bun run build:type-dependencies` |
| Cross-package type checking | `bun run type-check` |
| Source test suites | `bun run test:pi` |
| Existing compiled-runtime tests | `bun run test:pi:dist` |
| Rust compile check / release binary | `bun run kernel:check` / `bun run kernel:build` |
| Rust workspace unit and state-machine tests | `bun run test:rust` |
| Release-kernel / Host native acceptance | `bun run test:kernel` |
| Host packaging boundary and cloud-layout helper tests | `bun run test:cloud` |
| Engineering docs / public docs plus engineering checks | `bun run docs:check` / `bun run docs:validate` |
| Documentation checker behavior tests | `bun run test:docs` |

`docs:validate` includes the engineering link scan. CI runs `test:docs` and then `docs:validate`, so
the repository is scanned once. Documentation checks do not prescribe status headers, index layout,
wording or translation coverage. Review those against the intended reader and current implementation;
do not encode an editorial preference as another build gate.

**Build output and running code.** `test:dist` consumes already built output. Build the owning package
first; do not silently test an earlier build. Electron type checking uses generated Host declarations
and need not overwrite a running `server/` generation. A source-development Host may use the permitted
Cargo runner; packaged layouts need the manifest-verified staged Rust executable.

The root `build:runtime-dependencies` orders shared package outputs by their dependency graph, once
per invocation. `build:type-dependencies` adds the Host declaration cache. Root `build`, `build:web`,
`type-check` and the cloud-runtime builder reuse these ordered outputs instead of recursively building
them again. Package `build` commands remain self-contained; `build:raw` consumes already prepared
dependencies and is for ordered aggregates, not a clean-checkout shortcut. `release:npm:build` has its
own smaller dependency graph for the public package set. Root `type-check:prepared` consumes the same
fresh outputs without rebuilding; `release:prepare` uses it after its completed build.

Web's aggregate `type-check` prepares dependencies and emits the Application Host's declarations before
checking browser and CLI consumers. Root `type-check` prepares those outputs once, then calls Web's
`type-check:prepared` alongside the other packages' checks; that prepared entry does not emit again.
Cross-layer tests use the existing `#application-host` boundary: TypeScript
reads those fresh declarations, while the native Vitest configuration resolves the same imports to
real Host source. Host implementations remain checked in their Node project; browser code keeps its
own DOM/lib settings. A successful type check is not execution of a listener-bearing native test.

**Test ownership.** UI and Web use Vitest. Native Web tests follow the `*.native.test.ts` convention and
run through the dedicated kernel entry rather than the portable Web suite. Electron separates runtime,
updater, Linux desktop and packaging-helper coverage. Python driver tests use
`python3 -m unittest discover -s packages/computer-driver/linux -p 'test_*.py'`; their simulated app
protocols do not replace an actual desktop run. Consult the package scripts before selecting files.

`test:rust` runs Cargo's workspace tests from `kernel/`, selecting its pinned toolchain. CI gives it one
Linux execution for kernel, protocol-generator, kernel-build/test entry or workflow changes. It protects
Rust-owned state machines separately from `test:kernel`, which runs Node/Vitest against a release binary
and does not run Cargo tests. The full workspace includes Host/guardian consumers: install the Node/tsx
and built Host/builtin dependencies first, and set `VARIN_TEST_KERNEL_EXECUTABLE` to the absolute path
of the matching built kernel binary. CI supplies the release binary verified by its preceding kernel
step; `test:rust` does not rebuild it. Pass `--build` to `test:kernel` when that binary needs building.

The built-in extension package's `test:dist` runs its existing `test:packaging` smoke against completed
language-server assets; the root dist aggregate and production-build CI own that check. The Host
production-boundary helper tests belong to `test:cloud` and use temporary fixtures without rebuilding
or starting the product. Mobile identity and harness replay checks remain focused entries for their
own changes rather than additional unconditional gates.

**Dependencies.** `bun.lock` owns the development graph; `scripts/cloud-runtime.bun.lock` owns the staged
production graph. Changes reaching the cloud runtime use `bun run update:cloud-runtime-lock` after the
relevant build outputs are prepared. Diagnostic dead-code output is reviewed for change relevance,
not treated as authorization to remove unrelated code.

## Dependency update review

[Dependency maintenance](ops/dependency-updates.md) owns Dependabot scheduling and reports, advisory
repairs, the Pi SDK adaptation seams and upgrade validation. Keep that operational detail there rather
than appending another SDK-upgrade history to this entry page.

## Git discipline

Inspect status before editing. Do not reset, clean or overwrite unrelated changes. Keep coherent phases
reviewable, commit and push completed repository work, and report what was actually verified. Releases,
publishing, deployment and credential changes still need the authority of the current task.
