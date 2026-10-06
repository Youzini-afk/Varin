# Varin development guide

Status: contributor guide — source setup, code ownership and useful verification.
Last updated: 2026-10-06

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
| Documentation or navigation | Actual local-link/reachability check; review changed facts and old chapter links |
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
| Native authority suite | `bun run test:kernel` |
| Engineering docs / public docs plus engineering checks | `bun run docs:check` / `bun run docs:validate` |
| Documentation checker tests plus repository check | `bun run test:docs` |

**Build output and running code.** `test:dist` consumes already built output. Build the owning package
first; do not silently test an earlier build. Electron type checking uses generated Host declarations
and need not overwrite a running `server/` generation. A source-development Host may use the permitted
Cargo runner; packaged layouts need the manifest-verified staged Rust executable.

**Test ownership.** UI and Web use Vitest. Native Web tests follow the `*.native.test.ts` convention and
run through the dedicated kernel entry rather than the portable Web suite. Electron separates runtime,
updater, Linux desktop and packaging-helper coverage. Python driver tests use
`python3 -m unittest discover -s packages/computer-driver/linux -p 'test_*.py'`; their simulated app
protocols do not replace an actual desktop run. Consult the package scripts before selecting files.

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
