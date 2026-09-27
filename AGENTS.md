# Varin contributor guide

## Start from current authority

Varin keeps project knowledge in ordinary repository documentation, next to the code it describes.
Start with [docs/development.md](docs/development.md), [docs/architecture.md](docs/architecture.md), and
the nearest `README.md` or `DOCUMENTATION.md` in the owning package or module.

Code, types, tests, schemas, and `package.json` scripts are executable authority. Documentation explains
ownership and intent. If prose and implementation disagree, inspect recent commits and callers, decide
which behavior is current, and update the stale side in the same change. Historical plans and the local
OpenChamber checkouts are reference material, not current authority.

The repository deliberately has no project-local workflow Skills. Do not add one merely to repeat a
module document, prescribe routine steps, or encode a one-off failure. A Skill is justified only when
the user explicitly wants a reusable, tool-specific operation that cannot be made clearer or more
reliable as code, a script, or normal documentation.

## Product boundary

- Varin is an independent Agent workspace and harness with a bundled Pi runtime, originating from
  the maintainer's OpenChamber fork. All Varin edits, commits, and pushes happen in this repository;
  external OpenChamber checkouts remain read-only.
- The OpenCode cutover is complete. Do not restore OpenCode contracts, compatibility facades, parallel
  implementations, or dead migration paths.
- Preserve the fork capabilities recorded in
  [docs/ops/openchamber-pi-migration.md](docs/ops/openchamber-pi-migration.md) unless a reviewed Pi-native
  implementation is behaviorally and security-equivalent.
- Do not add speculative restrictions. A limit needs a concrete protocol, platform, safety, data, or
  measured resource failure behind it; defaults, warnings, and configurable budgets are distinct from
  hard rejection.
- There are no users requiring backward compatibility for Varin's internal formats. Replace obsolete
  contracts and storage directly; remove old readers, writers, compatibility branches, and fallback
  backends. Do not build internal-format upgrade/import machinery. Workspace files, Git history, native
  Pi data, and external configuration remain assets; handing off unfinished work does not require keeping
  the old internal schema. Normal durability and recovery still apply within the current format (D-253).

## Ownership and trust boundaries

- `packages/application-client` owns the framework-neutral `RuntimeAPIs` aggregate interface, all API
  interfaces, typed failures, and pure DTO types. It has no React, Zustand, or UI component dependencies.
- `packages/ui` owns shared React presentation, Pi domain state, the Document Registry, and the Editor
  Workbench Kernel. It does not own privileged processes or the runtime-facing client contracts.
- `packages/web` owns Web/remote surfaces and the trusted application host, including document, search,
  language, task, debug, test, and Pi runtime services.
- `packages/electron` is the native shell. It hosts the Web application host in-process and must not
  grow a parallel backend.
- `packages/mobile` is a Capacitor client connected to a Varin server.
- Runtime, protocol, and extension packages own their named process and contract boundaries as mapped in
  [docs/architecture.md](docs/architecture.md).
- Stage R in [docs/plan/agent-harness-plan.md](docs/plan/agent-harness-plan.md) completed the Rust system-kernel
  transition at D-282; [docs/design/rust-kernel-design.md](docs/design/rust-kernel-design.md) owns its implemented boundaries.
  Rust is the production authority for the transferred state, file, materialization, process, and compute
  resources. Do not reintroduce dual TS/Rust writers or fallback authorities. The kernel is a private
  Application Host component shared by surfaces, not a second Electron backend. Delivery facts remain in
  harness status.

Never execute Pi extensions in a renderer. Keep privileged filesystem, network, credential, shell, and
process behavior in the application host, Electron main/preload, or Pi host as appropriate. Validate
untrusted process/network input and never log credentials, prompt bodies,
bearer/pairing data, or file contents.

## Workbench and data invariants

- Agent Workspace (`default`), IDE Workbench (`varin.ide`), and Research Workbench (`varin.research`)
  are extension-provided shells selected through Workbench Profiles. Work focus is independent session
  execution configuration; project or session navigation never changes the selected shell.
- Shells own presentation. Documents, editor groups, terminals, Git, profiles, and runtime identity
  remain in the shared kernel or their trusted host authority.
- `DocumentsAPI` is the single text-content path. `FilesAPI` remains browse/binary/CRUD and
  `WorkspaceAPI` remains project/tree/Git/upload.
- Desktop/Web Agent and IDE share the Monaco document path. Mobile and embedded editors use their
  purpose-specific CodeMirror adapters. None creates another buffer,
  dirty-state, save, or language-process authority.
- Pi session JSONL, Pi settings/packages, and plugin-native configuration remain their documented
  authorities. Missing, empty, malformed, stale, failed, and conflicting states must not collapse into
  the same successful empty result.
- Commit a profile, shell, provider, or owner generation only after its candidate is ready. Failed or
  superseded work leaves the previous authoritative generation active.

## Changes, verification, and Git

Inspect the owning implementation, consumers, and focused tests before changing behavior. Choose
verification by what could actually regress: a local change needs focused evidence; a shared contract
needs its real consumers; packaging and platform behavior need the relevant runtime or smoke check.
Do not repeat broad checks that cannot change the decision. The command source of truth is the nearest
`package.json`; repository development and validation details live in
[docs/development.md](docs/development.md).

Do not add a test automatically for every edit or fix. Reuse existing behavior coverage; simple
presentation changes and static type shapes often need no new test. Tests must exercise product
behavior, not copy implementation text, CSS classes, enum lists, or assert values from a literal they
just constructed. Remove obsolete and redundant tests without requiring one-for-one replacements.
Keep release smoke focused on the installed product's startup and working capabilities; detailed
failure combinations belong to their owning behavior tests, and visual preferences are not release gates.

Preserve unrelated user changes and avoid destructive Git operations. Keep coherent phases reviewable,
commit and push completed phases, and report what was and was not verified.
