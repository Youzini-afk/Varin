# Testing and CI audit — Stage Q (D-292)

Baseline: `a92140df` (`docs: plan testing and CI redesign before AI4S`).
The sections below record Stage Q's historical findings and dispositions. Current test-content
reduction, including corrections to retained checks, is recorded in §11.
Scope covered: every `packages/*/package.json` test/build entry, all Vitest
configs, `scripts/test-*.mjs`, `.github/workflows/*`, and the representative
files listed in the stage plan. This is an entry-and-family audit, not a
line-by-line review of all ~800 test files; dispositions for families not yet
inspected are marked **unknown**.

## 1. Execution entries today

| Entry | Command | Runner | Discovery |
| --- | --- | --- | --- |
| `test:pi` | `bun run --sequential --no-exit-on-error --filter '@varin/*' test` | mixed | every `@varin/*` package `test` script |
| `test:pi:dist` | same filter, `test:dist` | node | only pi-host, runtime-broker, runtime-client define it |
| `test:kernel` | `node scripts/test-kernel-authority.mjs` | node --test + vitest | explicit file list, requires release kernel |
| `test:cloud` | `bunx vitest run scripts/cloud-runtime-layout.test.js scripts/cloud-remote-deploy.test.js scripts/docker-cloud-tools.test.js` | vitest | 3 files |
| `test:node-smoke` | `bun run build:application-host && node --test application-host/lib/knowledge/store.smoke.test.ts` | node | 1 file |
| `test:i18n` | `vitest run src/lib/i18n/messages.test.ts src/lib/i18n/messages/i18nParity.test.ts` | vitest | 2 of 6 i18n files |
| Electron | `test:runtime` / `test:architecture` / `test:updater` / `test:linux-desktop` | vitest + node | see §4 |
| docs | `bun run docs:validate`, `test:docs` | node scripts | docs tree |
| packages (flat) | `tsx --test test/**/*.test.ts` / `src/**/*.test.ts` | node --test | **unquoted glob — see §2** |
| packages/vscode | *no `test` script* | none | **17 files dead — see §5** |

## 2. Discovery defects

### 2.1 Unquoted `**` glob in `tsx --test` scripts (confirmed)

`"test": "tsx --test test/**/*.test.ts"` relies on shell glob expansion.
In bash without `globstar`, `**` collapses to `*`, so the pattern becomes
`test/*/*.test.ts` — only one directory level deep.

- `packages/pi-host`: 37 files at `test/*.test.ts` + 38 at `test/*/*.test.ts`
  = 75 total. POSIX-shell expansion silently drops the 37 root files
  (~half the suite, incl. `zone0-stability`, `pi-hooks-contract`,
  permission-gate, session e2e). Matches the design-recorded Linux-vs-Windows
  divergence (247 vs 393 tests).
- Flat packages (`protocol`, `runtime-broker`, `extension-*`,
  `application-client`, `runtime-client`, `settings-store`, …) keep all tests
  at `test/*.test.ts`; the collapsed pattern matches nothing and falls through
  to the runner, whose own glob then still resolves the files — so flat
  packages are only accidentally correct, and pi-host is silently wrong.

Disposition: **fix** — quote the glob (`tsx --test "test/**/*.test.ts"`) so
the runner owns discovery on every platform. Verified working on Windows for
the full pi-host suite.

### 2.2 Kernel/native tests have two owners (confirmed)

`scripts/test-kernel-authority.mjs` builds/requires a release kernel and runs
`kernel-client.test.ts` (node --test) plus 9 vitest files. All 9 are also
inside `packages/web` `vitest run` (only `kernel-client` is excluded), and
five more kernel-requiring files use
`createAuthorityTestRuntime` (`await fs.access(kernelPath)`):

- `lib/kernel/{file-resource-audit,kernel-compute,kernel-process,
  kernel-transport.acceptance,process-consumers,request-window,
  storage-adapter}.test.ts`
- `lib/recovery/kernel-durable-engine.native.test.ts`
- `lib/harness/shell-assembly.native.test.ts`
- `lib/lsp/bundled-language.native.test.ts` (kernel-gated, **not** in the authority
  list — hidden `skipIf` in the Web suite; only runs when a binary exists)
- `lib/documents/authority-surface-identity.native.test.ts`,
  `lib/harness/document-read-source.native.test.ts`,
  `lib/harness/thread-lifecycle.acceptance.native.test.ts`,
  `lib/harness/working-state/materialized-baseline-update.acceptance.native.test.ts`,
  `test/integration-surface-vertical.native.test.ts` (fail hard when the kernel is
  absent or stale)

Consequences measured locally: `bun run test:pi` on a checkout whose
`kernel/target/release` binary is stale (host 0.9.12 vs kernel 0.9.11)
produces ~17 failures across these files; on a checkout with no binary the
`skipIf` files silently pass without testing anything. `test:pi` is thus not
deterministic without a fresh kernel build, and the kernel tests run twice in
CI (inside `test:pi` and again via `test:kernel`).

Disposition: **re-own** — all native/kernel-path test files belong to the
kernel authority entry (fresh, manifest-matched binary). The Web suite must
exclude them so `vitest run` is deterministic without Rust artifacts. Because
Vitest `exclude` also filters CLI file arguments, the kernel set needs its
own Vitest config rather than an exclusion plus file list.

### 2.3 i18n specialized entry duplicates the UI suite (confirmed)

`test:i18n` runs 2 of 6 i18n test files; all 6 already run inside
`vitest run` (the `test` script consumed by `test:pi`). CI additionally runs
`bun run test:i18n` as a separate step — pure duplicate execution.

Disposition: **merge** — i18n files stay in the UI unit suite; drop the CI
step. Keep `test:i18n` as a local convenience alias (documented as such).

### 2.4 Electron entries overlap (confirmed)

- `test:runtime` = `vitest run` → all top-level `*.test.ts` including the four
  `updater-*.test.ts` and `linux-autostart.test.ts`.
- `test:architecture` = `prepare:pi-runtime` + `test:runtime` + `node --test`
  scripts/*.test.mjs.
- `test:updater` re-runs the 4 updater vitest files + 2 node scripts.
- `test:linux-desktop` re-runs `linux-autostart.test.ts` + 2 smokes.

In CI (`windows-runtime` runs `test:architecture` + `test:updater`) the
updater files execute twice and the full vitest suite runs twice.

Disposition: **split ownership** — the main vitest config excludes
`updater-*.test.ts` and `linux-autostart.test.ts`; those files are owned by
`test:updater` / `test:linux-desktop` respectively. Every file still runs,
each exactly once.

## 3. False-success and formalistic tests

### 3.1 Zone 0 stability (confirmed defect)

`packages/pi-host/test/zone0-stability.test.ts` configures a faux provider
with a fixed list of 5 responses but drives 5 prompts that include tool-call
continuations; the actual provider-call count exceeds the fixture. Observed
~93 s runtime and failure. Provider exhaustion does not fail fast — it
surfaces as timeout/retry noise, and terminal state is not asserted.

Disposition: **repair** — make the faux provider fail loudly on unexpected
requests, give every expected call an explicit response, assert terminal
success and byte-identical Zone 0 prefix growth. Do not raise timeouts.

### 3.2 Retired recovery engine used as production evidence (confirmed)

Production wiring (`application-host/index.ts`):
`createWorkspaceRecoveryEngine` (`lib/recovery/journal-engine.ts`) over
`kernelRecoveryStore`/`KernelRecoveryContentStore`, wrapped by
`createKernelRecoveryDirectFacade`. The kernel owns durable state.

`lib/recovery/local-sqlite-recovery-engine.test-helper.ts` is a ~3,585-line
re-implementation of the whole engine surface — the retired pre-kernel
engine, used only by tests:

- `engine.test.ts` (~1,370 lines) tests this dead engine directly.
- `service-integration.test.ts` (~173 lines) tests capability dispatch
  through it.
- ~7 consumer test files import it as their engine fixture.

Testing the retired engine proves nothing about production, and ~3,585 lines
of parallel state machine must be kept behavior-identical by hand. A narrow
in-memory port already exists
(`lib/recovery/recovery-durable-port.test-helper.ts`, ~197 lines,
`RecoveryDurableMetadataPort`) and is used by 3 tests.

Disposition: **replace** — point engine/consumer tests at the production
`createWorkspaceRecoveryEngine` with the in-memory durable port, then delete
the retired engine helper. Keep `kernel-durable-engine.native.test.ts` and the
native vertical files as the authoritative-path evidence.

### 3.3 Source-text / statement-order tests

| File | Pattern | Disposition |
| --- | --- | --- |
| `ui/src/App.pi-root.test.ts` | `readFileSync(App.tsx)` + `toContain` | **delete** — asserts absence of retired OpenCode symbols and presence of identifiers; no user behavior. Real boot behavior belongs to a render test if a gap remains. |
| `ui/src/apps/MobileApp.pi-root.test.ts` | same | **delete** (same reason) |
| `ui/src/components/**/​*.pi-root.test.ts` (4 files) | same migration-era source assertions | **delete** |
| `ui/src/components/views/__tests__/terminalViewportRemount.test.ts`, `mainLayoutMobileSidebarMount.test.ts` | source/DOM-text assertions | **review** — replace with rendered-behavior assertions or delete |
| `ui/src/components/ui/varin-splash-lattice.test.ts`, `varin-logo-geometry.test.ts` | reads SVG/component source | **review** — geometric invariants may be tested on rendered output |
| `vscode/src/webviewHtml.test.ts` | regexes `workerSrc`/`scriptSrc` out of source | **replace** — call the real HTML/CSP generator and assert on its output (real security boundary) |
| `scripts/cloud-remote-deploy.test.js` | `indexOf` statement-order assertions on deploy scripts | **delete** — the production-build deploy smoke exercises real archive→deploy→health→rollback; statement order proves nothing. Note: Windows-local install ordering it checks is *not* covered by the Linux deploy smoke — record as residual gap, do not keep text test for it. |
| `scripts/cloud-runtime-layout.test.js` | lock-file content checks + builder-source `toContain` | **keep** the `cloud-runtime.bun.lock` package-closure assertions (real artifact input to `--frozen-lockfile`); **trim** builder-source text checks |
| `scripts/docker-cloud-tools.test.js` | parses Dockerfile/apt package lists, workspace-manifest COPY completeness, workflow text | **keep** artifact-closure checks (every workspace manifest COPY'd, apt deps, entrypoint); **trim** pure workflow-structure assertions |
| `scripts/host-production-boundary.test.mjs` | exercises real `inspectHostProductionGraph`/`pruneLegacyHostArtifacts` on fixture trees | **keep** — behavior test of a real packaging tool |
| `electron/architecture.test.ts` | file-set + `no-any`/`@ts-ignore` source scan | **keep** file-set boundary (no parallel JS backend); the `no-any` property overlaps lint — low priority to migrate |
| `web/…/architecture.test.ts`, `cli/architecture.test.ts` | import-graph boundary | **keep** — production import graph is an explicitly protected boundary |

### 3.4 Docs gates

`docs:validate`/`test:docs` mostly run real checks (links, page routes,
validator behavior). The commit-date↔document-date sync gate exists only to
keep prose timestamps fresh — it blocks unrelated work and proves no
capability. Disposition: **remove** the date gate; keep link/route/structure
checks. (Confirm exact location during Q1.)

### 3.5 Remaining `readFileSync` tests

~50 test files read files. Most are legitimate (fixture inputs, built-output
checks, message catalogs). The `*.pi-root.test.ts` family above is the
source-text offender. Unknown: some `web` tests reading source for wiring
assertions (e.g. `startup-pipeline-runtime.test.ts`,
`shell-integration-scripts.test.ts`) — **review in Q1**; where they assert
generated artifact content they are acceptable, where they assert statement
presence they are not.

## 4. Build / smoke duplication

- `test:node-smoke` = `build:application-host` + node --test 1 file; then
  `test:pi:dist` runs dist smoke in 3 packages, each rebuilding or rebuilding
  against dist. Production-build job then builds the full production bundle
  again. Measured cost is acceptable but ownership is fuzzy.
- `desktop-release.yml` re-runs the whole source-quality suite before
  packaging — same-environment duplicate execution. Disposition: reuse the
  `production-build` artifact or gate on its success instead of re-verifying.
- `docker.yml` + `cloud` smoke: immutable image smokes set
  `VARIN_UI_PASSWORD=varin-ci-smoke-only` and verify health — real
  artifact tests, **keep**.

## 5. Dead suite: packages/vscode

17 test files, **no `test` script** — never run by `test:pi`
(package name `varin` is outside the `@varin/*` filter) and never run in
CI except `test-pi-runtime.mjs`/`test-search.mjs` harness checks.

Measured `bun test` run: 53 pass, 6 fail, 5 file-level errors:

- 5 files (`webviewHtml.test.ts`, `webview/piRuntimeTransport.test.ts`,
  `webview/api/{bridge,bridge-acquire-fallback,documents}.test.ts`) use
  `node:test` `describe`/`test` nesting that Bun does not implement —
  runner-level `ERR_NOT_IMPLEMENTED`. **Replace**: port these small files to
  `bun:test` (trivial) so one runner owns the package; `webviewHtml` is
  rewritten per §3.3 anyway.
- `search-runtime.test.ts` "bridges to a manifest-verified release kernel"
  fails locally against the stale 0.9.11 binary — real kernel test,
  environmental failure locally; runs against the packaged runtime in CI.

Disposition: **wire** — add `test` (`bun test`) to the package, migrate the 5
node:test files, add a CI step so the suite is no longer dead.

Amended by D-294: the runner wiring was done, but the CI step was removed
again — the package is a deprecated/unsupported historical adapter outside
the formal product surface (see §10), so its suite stays runnable but is not
required evidence.

## 6. Cloud deploy smoke failure (root-caused)

CI failure signature: `VARIN_UI_PASSWORD is not set` →
`Varin daemon exited before reporting ready (code 1)` on the **first**
"good" deploy; rollback scenarios never execute.

Local reproduction (staged runtime + `bun install --production
--frozen-lockfile` + `cli.js serve`) produced the real daemon error, now
surfaced through the new log tail: `Cannot find module
'@varin/extension-builtins'` from `server/index.js`. Root cause:
`extension-builtins` was declared in `devDependencies` (1f83c02b) while the
shipped server and application host import it at runtime, so the deploy's
`--production` install never linked it — and the canonical
`cloud-runtime.bun.lock` was stale (web 0.9.11, missing the dep), which the
build-time `--frozen-lockfile` verification did not catch because it only
checks the root manifest.

Classification: **product/artifact + diagnostics**, not test noise.
Resolution in Q2: moved `extension-builtins` to web `dependencies`,
regenerated `cloud-runtime.bun.lock` (web 0.9.12 + the missing workspace
dep), added `@varin/extension-builtins` resolution to both the build-time
`requireInstall` check and the deploy post-install verification, and made
`deploy-cloud-runtime.sh` print the daemon log tail on rollback. Verified
end-to-end locally: staged runtime installs the link, daemon reports ready,
`/health` answers.

The stale local `kernel/` artifact (0.9.11 vs host 0.9.12) seen during
reproduction is a separate environment issue — on CI the kernel is compiled
in the same job (`buildIdentity: 0.9.12` in the failing run's log), so it
was never the CI cause.

## 7. Platform coverage

- `windows-runtime` job re-runs kernel build + `test:pi` + Electron suites —
  genuine platform evidence (paths, process spawning, updater). Keep the
  platform gate; dedupe within the job (single kernel build feeding all
  steps; Electron ownership per §2.4).
- `production-build` duplicates `source-quality` verification. Keep it as
  the **artifact** gate: build once, run dist/cloud/vsix checks against that
  artifact; do not re-run the source suite.
- Docs-only changes currently trigger every job including Docker/native.
  Add path filters so docs-only diffs run the docs/source gates only.

## 8. Disposition summary

| Family | Disposition |
| --- | --- |
| `tsx --test` unquoted globs (12 packages) | fix — quote pattern |
| kernel/native web tests (15 files) | re-own under `test:kernel` via dedicated vitest config |
| `test:i18n` CI step | merge into UI suite; drop duplicate CI step |
| Electron runtime/updater/linux overlap | split vitest ownership |
| `zone0-stability.test.ts` | repair fixture + terminal assertions |
| `local-sqlite-recovery-engine.test-helper.ts` + `engine.test.ts` | retarget to production engine + in-memory port; delete retired engine |
| `*.pi-root.test.ts` (7 files) | delete (retired-migration source text) |
| `webviewHtml.test.ts` | replace with generator-output assertion |
| `cloud-remote-deploy.test.js` | delete (covered by real deploy smoke) |
| `cloud-runtime-layout`/`docker-cloud-tools` | keep artifact-closure checks, trim text checks |
| vscode suite | wire runner, migrate 5 node:test files |
| docs date gate | remove date sync check |
| cloud deploy smoke | fix artifact kernel identity + failure logging |
| desktop-release re-verification | consume build artifacts instead of re-running suite |
| docs-only CI triggering | add path filters |
| `thread-runtime.test.ts` (4,007 lines), explore*.test.ts family | **unknown** — reviewed for duplication in Q1 only if touched; they are real behavior tests on inspection samples |
| `settings-store`, `protocol`, `runtime-*`, `extension-*` suites | **retain** — input/output and boundary tests; glob fix only |

## 9. Q1 outcomes on the open questions

1. **local-sqlite helper removal** — resolved. Consumers split into two
   fixtures: recovery-semantics tests now drive the production
   `createWorkspaceRecoveryEngine` over a faithful in-memory durable port
   (`recovery-durable-port.test-helper.ts`), and `WorkingStateStore` tests
   use an explicit SQLite catalog context shim with real object GC
   (`working-state-root-adapter.test-helper.ts`). The 3.5k-line retired
   engine is deleted. Crash/recovery expectations were rewritten to the
   journal-engine semantics (navigation rejection stays resumable;
   compensation crash reaches `needs-attention`; host-kill leaves the
   catalog at the pre-crash state).
2. **`.pi-root` deletions** — resolved. The 6 files asserted retired
   OpenCode symbols and identifier presence, not user behavior; boot
   catalog and surface resolution remain covered by the UI suite.
3. **Docs date gate** — resolved. `checkLastUpdated` in
   `scripts/docs/engineering-docs.mjs` compared `Last updated:` against
   the file's last commit date via a per-file `git log` call in
   `validate-docs.mjs`. The comparison, the git machinery, and the
   shallow-clone branch are removed; ISO-format and future-date checks
   remain.
4. **`cloud-runtime.bun.lock` authority** — still open for Q2; the lock
   file remains the `--frozen-lockfile` input, and the cloud smoke's
   first-deploy failure is a kernel-identity artifact issue (§6), not a
   lock problem.
5. **Windows-local install ordering** — residual gap accepted. The
   statement-order text test is deleted; the Linux deploy smoke covers
   archive→deploy→health→rollback on the real artifact, and no
   fixture-level Windows install check exists.
6. **`terminalViewportRemount.test.ts`** — deleted. It asserted source
   text of `TerminalView.tsx`/`TerminalViewport.tsx`; the remount-churn
   regression it guarded (session-id in the viewport key rebuilding the
   WASM terminal) now has no behavioral coverage — the UI suite has no
   renderer-level terminal harness. Accepted residual gap.
7. **`mainLayoutMobileSidebarMount.test.ts`** — listed in the audit but
   does not exist in the tree; nothing to do.
8. **`webviewHtml.test.ts`** — replaced with a real `getWebviewHtml`
   call asserting the generated CSP (`worker-src` allows `blob:`,
   `script-src` does not).
9. **VS Code suite** — wired (`test` = `bun test`), all `node:test`
   imports migrated, `documents.test.ts` isolated from the module-cached
   bridge via a query-busted bridge + `mock.module`, and the worktree
   bootstrap test now disables `gc.auto`/`maintenance.auto` in fixture
   repos and polls bounded `rm` retries, ending the Windows `EBUSY`
   flake and the dangling git child. `search-runtime` passes against a
   rebuilt 0.9.12 kernel.
10. **`startup-pipeline-runtime.test.ts`** — kept the ordering behavior
    test; removed the retired-OpenCode source scan.

## 10. Q2 outcomes

- **Kernel/native ownership** — `packages/web/vitest.config.ts` excludes
  the 17 kernel/native files; `vitest.kernel.config.ts` (rooted at
  `packages/web`) owns them under `test:kernel`, which first runs the
  `kernel-client` node:test contract. Measured: main suite 271 files /
  2,334 tests green; kernel entry 26 node tests + 17 files / 120 tests
  green. No file executes twice per environment.
- **Electron split** — main vitest config excludes `updater-*.test.ts`
  and `linux-autostart.test.ts`; `vitest.dedicated.config.ts` owns them
  for `test:updater` / `test:linux-desktop`. windows-runtime now runs all
  three entries; measured 9+4+1 files, each once.
- **i18n CI step** — dropped from `source-quality` and
  `desktop-release.yml`; the UI suite inside `test:pi` already covers the
  same files, so the dedicated step was a second execution of the same
  environment.
- **vscode suite boundary correction (D-294/D-295)** — `bun run --cwd
  packages/vscode test` was briefly added to `windows-runtime`, then
  removed: `packages/vscode` is a deprecated/unsupported historical
  adapter outside the formal product surface, so its suite is not Q
  product evidence and not a required check. Measured full `bun test`:
  57–58 pass / 1–2 fail — `src/webviewHtml.test.ts` passes standalone
  but fails in the full suite from cross-file `mock.module('vscode')`
  pollution (`vscode.Uri.joinPath` undefined), plus a flaky worktree
  bootstrap fixture; both are test-assembly issues, not product faults.
  The suite was not fixed and the code/tests stay in the repo; D-295 also
  removes the package from root aggregate type-check/lint and the
  production-build VS Code runtime gates; the aggregate build entry remains
  until the dedicated cleanup stage. Full removal, build-entry, and
  doc cleanup belong to a later dedicated stage.
- **node-smoke** — moved out of `source-quality`; `production-build` runs
  `node --test .../store.smoke.test.ts` against the artifact `bun run
  build` already produced, instead of rebuilding the host a second time.
- **Docs-only diffs** — a `changes` job classifies the diff; docs gates
  (`test:docs`, `docs:validate`) always run in `source-quality`, every
  other step and the windows-runtime/production-build jobs skip when the
  diff is docs-only (skipped jobs report success honestly, so required
  checks still map to real jobs). `docker.yml` gained
  `!packages/docs/**` with `packages/docs/package.json` re-included.
- **Cloud failure diagnosis** — deploy script prints the daemon log tail
  (`$VARIN_DATA_DIR/logs/varin-<port>.log`) inside `rollback`; the
  post-install check and `requireInstall` verification now assert
  `@varin/extension-builtins` resolves.
- **Clock-assertion flake** — `thread-wait-admission` "inform does not
  wake" no longer asserts `returned === false` after `delay(35)` (the
  Windows CI failure was a late-firing timer, not a product defect); it
  now waits for the durable `held` record and asserts `timedOut` on the
  result, which fails identically if an inform ever wakes the wait.

### Still open

- `desktop-release.yml` re-verification still re-runs the source suite
  against the release ref rather than consuming the CI `production-build`
  artifact — kept deliberately since the ref may differ from any CI run.
- The `windows-runtime` job re-runs `test:pi` on Windows as platform
  evidence; that is intentional duplication across platforms, not within
  one environment.
- Windows-local deploy/install ordering (what
  `cloud-remote-deploy.test.js` used to text-assert) has no behavioral
  coverage — the deploy smoke is Linux-only; accepted residual gap.
- `thread-runtime.test.ts` (4,007 lines) and the `explore*` family were
  not restructured — spot checks show real behavior tests, not fixtures
  worth touching without a concrete defect.

## 11. Test-content reduction (2026-09-21)

The follow-up addresses maintenance burden inside the tests and smoke programs. Stage Q's runner
and ownership cleanup did not remove all tests that merely froze implementation details. At this
pass's baseline (`8ba91026`), there were 816 JS/TS `.test`/`.spec` files with 158,778 lines, excluding
Rust tests, helpers and standalone verification scripts. After this pass: 809 files, 157,090 lines.
These counts describe source content, not executed test cases or a deletion target.

| Area | Disposition and remaining evidence |
| --- | --- |
| UI source scans | Deleted sidebar, language-page and model-selector source-text tests and the retired kernel migration scan. UI behavior tests remain; normal component extraction and CSS changes no longer have to satisfy copied JSX. |
| Splash/logo/localization | Removed renderer `toString()`, generated CSS/HTML, SVG source and component-call text assertions. Retained projection, tile coverage, playback lifecycle and dictionary consistency tests. Regeneration remains `bun run splash:emit`. |
| Protocol/application-client | Removed DTO-literal self-checks, enum/constant/catalog mirrors and duplicate export checks. Runtime parsing, known/unknown guards, settings merging, capability resolution and error behavior remain. |
| Host/Electron architecture | Removed completed TypeScript-migration and duplicate lint scans. CLI checks for accidentally importing generated artifacts remain because source-tool resolution can otherwise hide a clean-install failure. |
| Docker/cloud | Deleted `docker-cloud-tools.test.js`, which duplicated Dockerfile commands, tool versions, Compose strings and workflow job names. Actual image build/start smokes remain. Cloud layout tests retain manifest/lock dependency agreement, dependency closure and real verifier behavior; fixed workspace lists are gone. |
| Documentation dates | Removed date presence/format/future-date gates, their timezone-slack helper and seven dedicated cases. Human dates remain metadata; local links, document reachability, site routes and delivery-status headers are still checked. |
| Shell integration | Deleted injected-script spelling/order assertions already covered by real Bash, PowerShell and zsh behavior tests. Launch argument and interpreter behavior checks remain. |
| Walkthrough locales | One check calls normalization with the actual UI locale values. Removed the source regex, redundant list comparisons, naming-style gate and test-only export of the private map. |
| Harness bridge fixture | Replaced its recursive mock search engine with boundary responses and moved large-output setup into its consumer case. Initial cwd and persistent cwd share one shell lifecycle; background output, paging and diagnostics still traverse the real bridge. |
| Windows package smoke | Removed composer width/borders/placement, control placement and pending-draft layout gates, including geometry collection. Kept real renderer, bundled Pi, language/recovery and terminal checks. Package completeness belongs to `after-pack`, rather than repeating it in the Windows smoke. |
| Release kernel smoke | One emitted-adapter/install-binary pass checks startup, actual file write, fixed search/structure, process output/exit, health and bad-manifest rejection. Removed a second copied-install run and conflict repetition; native kernel tests retain durable restart and conflict semantics. No longer reports `relocatedRestart`. |
| Linux package smoke | AppImage payload verification and desktop startup now consume the same extraction. Both architecture verification and real startup remain. |

No replacement-test quota, new test framework, skip-to-green behavior or timeout increase was introduced.
Production permissions and data-integrity behavior are unchanged. The large thread/runtime, file-authority and recovery suites were
not deleted by size: sampled cases exercise distinct preservation, conflict and lifecycle failures.
This pass does not claim a line-by-line review of every retained test or a measured overall CI speedup.

Validation used the changed behavior suites and scripts: protocol/application-client, retained UI
geometry/playback and localization, Electron runtime, cloud layout, CLI/shell/locale tests, the real
Harness bridge and the simplified release-kernel smoke against existing Windows x64 artifacts.
No new installers, full source-suite rerun or cross-platform desktop launch was required for this cleanup.

## 12. Whole-project test cleanup (2026-10-03)

This pass starts at `14df00de`. The inventory covered every maintained package, its runners,
test imports/helpers and release workflows, including the Python desktop drivers and four Rust
unit tests outside the JS/TS inventory. Scientific replay/evaluation assets were classified
separately from software regressions. At the start there were 918 tracked JS/TS test files and
184,836 lines; after cleanup there are 907 files and 182,184 lines. Python retains three files
with four discoverable tests. These are source counts, not execution counts or deletion targets.

The implementation changes test content, fixtures, discovery, commands and documentation.
Production source, dependency locks and application behavior are unchanged. Fast, distinct
behavior checks remain even where their package needed no edits. The review used family-level
inventory and direct reading of the relevant implementation, consumers and suspect assertions;
it does not claim every retained assertion was read line by line.

### Dispositions across maintained modules

| Area | Change and retained protection |
| --- | --- |
| UI components, stores and hooks | UI/Web tests now import Vitest directly; removed the Bun adapter and its incomplete handwritten matcher types. Removed a deleted Hook's copied algorithm and a Git-dialog reproduction that never rendered the dialog. NumberInput and SessionAuthGate now mount actual React and dispatch input/form events. Stable user state, async races, pending input, selection, queue, clipboard, editor/document and extension activation tests remain. |
| Chat scrolling, chrome and localization | Removed authored logo geometry, icon/animation-class checks and duplicated locale coverage. Removed tests of the retired visibility-ratio picker and empty-map no-op assertions. Six compact scroll tests cover current position selection at large offsets, the bottom spacer, frame coalescing and cleanup. Locale key/placeholder parity and splash playback remain. |
| Web memory and knowledge | All 30 organizer scenarios retain real Trivium stores, writes, reopen/retry, provenance and stale-proposal protection. Only delay timers are controlled; filesystem I/O and time used by the polling deadline stay real. Organizer instances and blocked inference callbacks are released at teardown. The automatic-disabled scenario now reaches settings evaluation before asserting no inference. |
| Web Git, worktrees and LSP | A small immutable repository template removes repeated initial Git setup; every test mutates its own real repository. Conflict, writer, worktree and hunk behavior remain. LSP cwd fallback uses an isolated project with positive and negative membership checks instead of scanning the developer's repository. Missing Git no longer silently passes 21 cases. |
| Web harness, resources, documents, recovery and semantic search | Retained distinct permission, lifecycle, conflict, data-preservation, authority and recovery checks. Eight previously misowned native files join the native runner. All 34 native Vitest files use `*.native.test.ts`, replacing the maintained filename allowlist; the portable runner excludes the same convention. Node framed transport remains separately owned. |
| Other Web domains | Retained the small behavior families for bots, auth, computers, connections, dictation/TTS, external access, filesystem, GitHub, language support, mobile, notifications, packages, platform/preview, projects, quotas, relay, runs, scheduling, security, session folders, shutdown, small-model/smart-search/structure, terminal/text, tunnels and walkthroughs. Their similar names do not imply duplicate consumer or failure paths. Platform cases now report unsupported environments as skipped rather than successful early returns. |
| Pi host | Retained actual SDK/tool-loop, provider, configuration, permission, context/compaction, retrieval, fleet and session behavior. Corrected an obsolete MCP event-channel expectation and authorization wording. Remote embedding/rerank E2E obtains the public inference binding instead of copying its configuration-digest algorithm. SDK adaptation checks retain the actual shipped SDK seam. |
| Runtime broker/client | Lifecycle/manager fixtures use the installed compatible Pi version and isolate package-manager probing where discovery and install plans are already supplied by the test. A callback wait fails if refresh finishes before entering it. Worker, admission, cwd, shutdown and transport tests remain. Broker smoke now expects the existing native Agent catalog and MCP owner. |
| Protocol, application-client and settings-store | Removed enum/catalog/type-literal mirrors and export-existence lists. Parsing/rejection, unknown-method guards, settings persistence, typed errors and relay registration remain. Shared auth timeout/abort/retry/late-publication protection uses Node's controlled timer instead of waiting for the real timeout. |
| Extension contract/SDK | Removed uninvoked callbacks, DTO self-checks, package-field mirrors and fixture-boolean self-checks. Unique malformed shell manifests moved into the shared schema/runtime fixture set; removed the second compiler and redundant schema cases. Runtime validation, client routing, asset confinement, lifecycle/abort and teardown remain. AJV is still used by the real schema suite. |
| Extension host/loader/surface/CLI/react/builtins | Retained real owner/generation, conflict, package-integrity, activation, disposal and generated-template behavior. React is validated by consumers and types. Builtin packaging smoke still launches copied language-server payloads and checks protocol results; it is artifact evidence, not another source suite. |
| Electron and Mobile | Removed duplicate desktop DTO checks and dev-script source matching; renderer security and compiled Pi/broker handshake remain. Mobile retains native IDs, app groups, schemes and Xcode references; removed inherited-brand scanning and PNG equality. Updater, archive, payload and architecture checks remain. |
| Desktop drivers | Converted the import-time CDP script to standard unittest discovery, using one ephemeral loopback HTTP/WebSocket fixture with explicit shutdown. Removed fixed ports, detached listener threads and unused protocol fixture state. Office document selection now goes through the public operation dispatcher. Existing published-generation and human-input cleanup checks remain. CI runs all four protocol tests without opening apps. |
| Rust kernel | Retained all four unit tests: frame truncation, required publish CAS, valid revoke admission and lease overlap/coverage. Real native acceptance still verifies persistence, restart, cancellation, grants, process trees, file operations and materialization. |
| Root scripts, dependencies and workflows | Deleted the obsolete `test-release-build.sh`/release-test aliases, which referenced a nonexistent workflow job and duplicated an incomplete packaging path. Dist tests consume the existing build. Targeted native Vitest calls no longer run unrelated Node transport tests. Linux-only desktop checks run on Linux; simulated UI runs once in source-quality, while Host/worker/filesystem suites still run on Windows. Removed both Bun test shims and dead auxiliary fields; retained Vitest, Linkedom, tsx and AJV because their consumers remain. |

The existing release-ref verification is retained: its selected ref can differ from a prior CI run.
Docker, VM and desktop artifact smokes remain owned by their corresponding build/release flows.
No new test framework, compatibility layer, test quota, timeout increase or production test hook
was added. The small Git fixture helper remains outside the emitted Host production boundary.

### Measured cost and verification

| Focused workload | Observed before → after | Why it changed |
| --- | --- | --- |
| Runtime lifecycle/manager, same 20 cases | 31.07 s → 0.44 s | Their supplied discovery/install results no longer trigger real host package-manager probes. |
| Memory organizer, same 30 cases | 134.99 s → 13.81 s | Controlled delay timers replace repeated two-second debounces/backoff waits; real stores and teardown remain. |
| TypeScript LSP, same five cases | 21.23 s → 1.55 s | The default-root case no longer walks the development checkout. |
| Shared auth timeout case | About 10 s → 21–25 ms | Advances the real timeout logic with Node's timer control, preserving abort, shared requests and rejection of late results. |
| Portable Web suite | 179.30 s → 55.05 s | Fixture cleanup plus eight native files moving to their own runner; this timing includes the ownership change. |

The memory/LSP baseline timings came from a full-package diagnostic run; focused after-runs
have different parallel load. They identify the removed cost and are not controlled performance
benchmarks. The original root baseline hung at an obsolete Pi fixture and required terminating
that test worker, so its 749.9 seconds are not used as an overall speedup comparison.
The current full native entry took 141.31 seconds and covers more files than the former entry.

Actual verification on Windows x64:

- `test:pi` ran every workspace source entry once: UI 347 files / 2,116 passed; portable Web
  323 files / 2,852 passed + four platform skips; Pi host 603 passed + one environment skip.
  Extension, protocol, client and settings entries completed successfully. Its one failure was
  the Broker's obsolete empty-provider assertion; after correcting native Agent/MCP expectations,
  the complete Broker entry passed all 92 cases. The aggregate command's original exit status
  remains recorded as failed; it was not rerun just to replace that log.
- Final scroll reduction followed that run: all six replacement/retained cases passed, and UI
  type-check passed. The final platform-label edits passed 96 portable cases + one missing-zsh
  skip and all seven shell-assembly native cases.
- Full `test:kernel`: 26 Node cases passed; 33 Vitest files passed and the optional MiniLM file
  skipped; 395 Vitest cases passed + two skipped without an installed model pack. No required
  release-kernel case skipped. Protocol generation was current; existing matching release bytes
  were used. The unchanged Cargo unit tests were reviewed and retained, not rebuilt separately.
- Compiled `test:pi:dist`: six cases passed without rebuilding dependencies inside each smoke.
- Electron architecture/runtime: 21 Vitest + 32 Node cases passed. Updater: 14 Vitest + seven
  Node cases passed. Linux desktop helper entry: three Vitest cases and both headless discovery/path
  smokes passed; POSIX unreadable-permission behavior could not be exercised by Windows chmod.
- Python driver discovery: four tests passed, using loopback protocols, boundary fakes and copied
  production component files. No browser, Office or desktop session was launched.
- Root release/dependency/production-boundary/replay helpers: 25 passed; cloud layout: 11 passed;
  docs checker: nine passed. The engineering/site documentation validator also passed.
- Owning source/test type-checks passed for UI, Web Host, Pi host, Broker, application-client,
  extension-contract and SDK. ESLint passed for changed code; CI YAML parsed successfully.

Local logs were captured as `varin-tests-after-cleanup.log`, `varin-broker-final-verification.log`,
`varin-tests-after-cleanup.log` and focused `varin-cleanup-*` logs beneath the task's
temporary directory. Remote CI was not polled, and new installers, live desktop smokes, Docker
deploys and VM boots were not run for this test-only change.

### Deliberately retained higher-risk evidence

Large thread/runtime, document authority, grants and recovery suites protect different lost-write,
ownership, cancellation and restart failures. They remain even where fixture bodies are verbose.
Native permission/session differences and the optional installed-model test remain explicitly
platform/component-dependent.

Three kinds of narrower checks retain a concrete reason: CLI import boundaries can be hidden by
source aliases while the emitted package is broken; the NSIS directory check is the only automated
guard for the historical repeated-child-directory failure; CodeMirror caret/selection specificity
checks guard prior invisible-handle and input-lag failures. Removing these without corresponding
artifact/browser evidence would lose protection. They do not prove actual installer or WebKit UI
behavior. The manual driver smoke remains a desktop diagnostic and is not counted among
the passing unit tests. Linux AT-SPI/UNO, Windows UIA and macOS AX still need their real platform
acceptance. Research replay inputs and historical experiment evidence remain scientific assets.

## 13. Behavior-focused follow-up (2026-10-05)

Starting at `156cd581`, this second pass reviewed the test families, runners, helpers and dependency
consumers across all maintained packages. Suspicious assertions were checked against their owning
implementation and callers. Tests were judged by the failure they could detect; existing assertions
were not treated as product requirements. This is a family-level review with direct examination of
the changed logic, not a claim that every retained assertion was read line by line.

Production behavior and dependency locks are unchanged. Eight test files were retired, and other
files were reduced or combined without a replacement quota or a new test framework.

| Area | Disposition and remaining protection |
| --- | --- |
| UI | Removed authored splash geometry/choreography, fixed theme colors/selectors, default editor presentation, literal chrome/translation wording, CSS-class checks and hardcoded package/layout counts. Kept final-frame retirement and WebGL disposal for the white-flash regression, viewport coverage, selected-versus-actual model identity, usage arithmetic, user editor preferences and interaction/state behavior. |
| Localization | Removed source regexes requiring every locale to physically spell every English key and duplicated settings/key lists. The runtime supports inherited English entries. One compact check calls the real formatter and verifies required parameters survive in the actual locale messages. Existing loading, fallback and stale asynchronous result checks remain. Empty suffix messages are valid and are not rejected. |
| Pi and protocol | Removed the bridge test's copied responder/router path and the phase3b file's default-policy repetitions, export checks and misleading integration fixture without an installed permission hook. Retained actual HostServicesBridge, Host/Pi flows and native gate hooks. Preset/custom-policy precedence and response correlation/error preservation moved into their existing owners. Tool rendering checks preserve supplied evidence rather than prose. |
| Host storage/recovery | Deleted self-tests for the non-shipped TS WorkingStateStore/state trie, its retention, and retired SQLite JournalCatalog/migrations. Production storage belongs to Rust. Real native roots, pinning, CAS, restart, owner cleanup and recovery tests remain; current capability evidence now points to them. The old modules still serve as boundary doubles for Host policy tests and are not claimed as production persistence evidence. |
| Documents and helpers | Inlined the single-consumer document contract suite into its owner, removing framework injection and handwritten matcher interfaces. All 40 document cases remain. Removed an unused durable root adapter factory. Shared filesystem/authority and live-surface failure fixtures remain where they support distinct conflict, recovery or cancellation behavior. |
| Other Host/CLI modules | Removed prompt prose, a private default dimension, export-existence/provider labels, a URL constant and a fixed tunnel-provider list. Actual dispatch, quota selection, framed terminal messages, CLI startup/transport and knowledge behavior remain. Native explore now checks authorized forwarding instead of reading implementation source to ban variable names. |
| Extensions and replay | Removed layout/seam/catalog counts. Retained real manifest parsing/roundtrip, profile mapping, owner generations, activation, routing, asset confinement and teardown. Replay still verifies real referenced tasks and non-overwriting records, without requiring exactly six tasks. |
| Electron and CI | Split existing Node packaging checks into `test:packaging-tools`. Local `test:architecture` still prepares dependencies, while Windows CI reuses `build:type-dependencies` and runs runtime/packaging entries directly. The same runtime, installer, architecture, update and payload checks remain. No validation gate was disabled. |
| Runtime broker/client, application-client, settings, mobile, drivers and Rust | Retained distinct process/session identity, correlation, cancellation, settings readers/writers, external API, platform identity and driver protocol behavior. Similar fixture inputs can exercise different implementations and do not alone make tests redundant. Built artifact checks and native acceptance remain separately owned. |

### Verification and discovered test faults

One final `bun run test:pi` exercised every workspace source entry. Pi passed 602 cases with one
environment skip; protocol passed 71, broker 96, and the other extension/client/settings entries
passed. UI passed 2,035 cases with three failures in one Bot file; portable Host/Web passed 2,806
with two failures and four platform skips. The aggregate exit status remains failed in its log.

Those failures exposed test problems rather than product regressions:

- Bot mounted Linkedom but sent Node's CustomEvent into its window. Use the simulated browser's
  Event/CustomEvent pair; all three interaction cases pass.
- The inherited-context assertion demanded a closing bracket immediately after the session attribute,
  rejecting the current provenance note. Verify the session identity independently of other attributes.
- Shell termination cases assumed preparation always finished within five milliseconds. Reuse the
  existing public execution/read readiness helper before testing kill/exit, preserving termination
  protection without tying it to machine speed. Both kill cases remain.

The two affected Host files then passed all 53 cases. Other successful package suites were not
rerun merely to replace the aggregate log. Additional risk-specific checks passed:

- Five native files: 36 cases against the existing matching release kernel. These cover working-state
  storage, durable recovery, explore forwarding, document surface identity, and the actual UI Registry
  → Documents → Host/kernel integration. Four files took 16.34 s; identity took 4.72 s separately.
- Electron runtime: 21 cases; the unchanged packaging test list through its new entry: 32 cases.
- Replay: three cases. UI, Pi and Host/CLI test type-checks and changed-code ESLint passed.
- Engineering docs: nine cases; documentation links/status validation and CI YAML parsing passed.

Source timings from the aggregate run were UI 29.52 s, portable Web 64.64 s, Pi 48.35 s and broker
69.24 s. They are observations under this local load, not a controlled before/after benchmark or
a claim of overall CI speedup. Logs are `varin-test-cleanup-20261005-all.log` and
`varin-test-cleanup-20261005-native.log` in the task's Windows temporary directory.

### Retained risks and boundaries

The live-surface completer, in-memory durable port and TS storage adapters remain controlled failure
boundaries for Host orchestration tests; they cannot prove real UI or Rust persistence behavior.
The real vertical Registry/kernel test provides complementary integration evidence. Replacing all
such fixtures at once would risk removing distinct lost-write, compensation and conflict coverage.
The single static CodeMirror caret scoping guard remains for the documented WebKit input-lag
regression; no real iOS acceptance was run. NSIS, public package/API and native identity checks retain
their concrete external contracts, rather than being removed simply because they inspect constants.

Vitest, Linkedom, better-sqlite3 and the grammar dev dependencies still have consumers: retained
fixtures use SQLite, and runtime asset staging uses tree-sitter WASM. No dependency was removed on
the strength of a source-import search alone. No new installer, live desktop, Linux/macOS acceptance,
Docker deployment or VM boot was required or claimed for this test-only pass.
