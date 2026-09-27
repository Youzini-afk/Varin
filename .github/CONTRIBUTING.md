English | [简体中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-CN.md) | [繁體中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-TW.md) | [Français](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.fr.md) | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# Contributing to Varin

Thank you for helping improve Varin. Contributions are welcome across the Pi runtime boundary,
desktop and remote surfaces, extension integrations, documentation, testing, accessibility, and
platform support.

This guide describes the public contribution workflow. [AGENTS.md](../AGENTS.md), the nearest package
README, and owning architecture documents contain the detailed repository rules for implementation
work.

## Documentation languages

User-facing documentation defaults to English. The root README, contribution guide, security policy,
and the root of the `packages/docs` content tree are the English source. Simplified Chinese and the
other locales are translations.

Keep factual behavior, commands, security guidance, and links synchronized across applicable
languages in the same change. Write new docs pages in English first, then add `zh-cn/` and the other
locale mirrors. Every localized root document must begin with a language switcher so readers never
need to return to the repository index to change language.

## Before you begin

- Read the [Code of Conduct](CODE_OF_CONDUCT.md).
- Use [GitHub Issues](https://github.com/Youzini-afk/Varin/issues) for reproducible bugs, feature
  proposals, and focused technical discussions.
- Send vulnerabilities through the private process in [SECURITY.md](SECURITY.md). Do not publish
  exploit details in an issue, discussion, pull request, log, or screenshot.
- Search existing issues and pull requests before starting a duplicate change.
- For a large product or architecture change, describe the user outcome and affected boundaries
  before investing in a full implementation. A prototype is welcome when it makes the trade-offs
  easier to evaluate.

## Project principles that affect contributions

Varin is not a generic wrapper around several coding-agent CLIs. It has one Pi-native domain and
one current pre-release runtime contract.

1. **Keep Pi authoritative.** Pi owns sessions, models, authentication, settings, packages, and the
   extension runtime. Project a JSON-safe Varin contract; do not clone Pi state into a parallel
   application schema.
2. **Preserve plugin ownership.** Integrate extensions through public commands, events, settings,
   and capability bridges. Do not parse private databases or duplicate plugin migrations merely to
   build a GUI.
3. **Avoid compatibility sediment.** During pre-1.0 development, all product surfaces move together.
   Remove obsolete OpenCode and superseded Varin paths once the replacement is accepted; do not
   accumulate protocol v13/v14-style shims without a real persisted-data or external-client need.
4. **Enforce privilege at the trusted boundary.** Renderers and remote clients cannot authorize
   themselves. Validate filesystem, process, network, project-trust, and credential operations in
   the host that owns the capability.
5. **Do not add arbitrary product limits.** Avoid silent truncation, model-count caps, short timeouts,
   or hidden concurrency ceilings. Operational budgets should be explicit deployment opt-ins with
   visible failure semantics.
6. **Keep failures truthful.** An authoritative failure is not a successful empty response. Make
   cancellation, partial failure, cleanup, retry, rollback, and unavailable capabilities visible.

Read [Architecture](../docs/architecture.md), [Plugin GUI design](../docs/design/plugin-gui-design.md),
[Recovery](../docs/design/recovery.md), and [Security model](../docs/design/security.md) when those boundaries apply.

## Development setup

### Requirements

- Node.js 22.19 or newer; Node.js 24 is the CI and supported development baseline
- Bun 1.3.14
- Git
- Git for Windows and Git Bash for Pi shell tools on Windows

### Clone and install

```bash
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run check:pi
```

`bun.lock` is authoritative. Do not switch package managers or regenerate the lockfile unless the
dependency change requires it. Review lifecycle-script changes carefully; Varin intentionally
allowlists only required install scripts.

## Common development surfaces

Run commands from the repository root unless noted otherwise.

| Goal | Command |
| --- | --- |
| Web UI with HMR and trusted API | `bun run dev` |
| Web build watcher plus server | `bun run dev:web:full` |
| Desktop with Web HMR | `bun run electron:dev` |
| Desktop using built assets | `bun run electron:dev:bundled` |
| Package desktop for the current OS | `bun run electron:build` |
| Package Windows x64 NSIS installer | `bun run electron:build:win` |
| Smoke an unpacked Windows build | `bun run electron:smoke:win` |
| Build mobile assets | `bun run mobile:build` |
| Build canonical cloud runtime | `bun run build:cloud-runtime` |
| Validate documentation site | `bun run docs:validate` |

The shared UI is a source library rather than a standalone app. Exercise UI behavior through Web or
Desktop so the runtime context is real.

## Choosing the owning package

| Area | Primary owner |
| --- | --- |
| Shared components, stores, settings, chat, and plugin GUI | `packages/ui` |
| Browser/remote server, HTTP APIs, WebSocket transport, cloud CLI | `packages/web` |
| Windows/macOS/Linux shell, preload/IPC, SSH, updater, packaging | `packages/electron` |
| Capacitor native shell | `packages/mobile` |
| JSON-safe wire contract and validation | `packages/protocol` |
| Browser/editor runtime client | `packages/runtime-client` |
| Worker ownership, routing, lifecycle, and shutdown | `packages/runtime-broker` |
| Pi SDK, sessions, packages, extensions, and trusted host operations | `packages/pi-host` |

Shared API changes often cross several packages, but one layer must remain authoritative. Do not
work around a missing contract with an unrelated local store or a renderer-only privilege check.

## Implementing a change

1. Identify the authoritative data source, trusted execution boundary, affected product surfaces,
   and failure behavior.
2. Read `AGENTS.md`, the nearest package README or `DOCUMENTATION.md`, and every matching project
   skill before editing imported product code.
3. Keep the change focused. Include directly required cleanup and tests, but separate unrelated
   refactors that make review harder.
4. Add or update the narrowest regression test that proves the behavior at its owning boundary.
5. Exercise every runtime surface whose contract changed. Type-checking a shared type is not proof
   that Desktop, Web, relay, or mobile behavior works.
6. Update user, contributor, architecture, security, or operational documentation in the same
   change when its contract changed.

When changing a versioned or persisted shape, prefer one clear migration into the current shape.
Retain old readers only when real user data or independently deployed clients require them, and
document the removal condition.

## Validation

### Broad baseline

Run the broad checks for code, dependency, export, or build changes:

```bash
bun run type-check
bun run lint
bun run check:pi
bun run build
```

Run these when the affected boundary applies:

| Change | Additional evidence |
| --- | --- |
| Pi host, protocol, broker, or runtime client | `bun run test:pi:dist` |
| Web server or transport | `bun run --cwd packages/web test` |
| Cloud runtime, Docker, or SSH deployment | `bun run test:cloud` and a canonical runtime build |
| Electron lifecycle, architecture, or updater | `bun run --cwd packages/electron test:architecture` and/or `test:updater` |
| Windows packaging or native modules | `bun run electron:build:win` followed by `bun run electron:smoke:win` |
| Imports, exports, or deletion | `bun run dead-code` and a production build of each affected surface |
| Documentation site | `bun run docs:validate` and manual checking of changed local links |
| Workspace `package.json` or root lockfile | `bun run update:cloud-runtime-lock` so `scripts/cloud-runtime.bun.lock` stays frozen |

CI repeats the main quality gates on Windows and Ubuntu. Cloud/runtime changes also build and smoke
candidate containers before any installable tags are promoted.

If a required check cannot run on your host, say exactly what was not tested and why. Do not turn an
untested platform assumption into a claim of support.

### User-visible changes

Provide evidence at the current pull request HEAD:

- screenshots for meaningful static before/after states;
- a short recording for motion, focus, drag-and-drop, gestures, or multi-step interactions;
- narrow and wide layouts for responsive shared UI;
- light and dark themes when colors or surfaces changed;
- relevant loading, empty, disabled, error, long-content, and high-contrast states;
- before/after measurements for performance, memory, CPU, startup, or rendering claims.

If there is no user-visible change, state why.

## Code and security style

- Use strict TypeScript and avoid `any` unless the boundary is genuinely dynamic and validated.
- Prefer small discriminated contracts, early returns, and explicit state transitions over nested
  conditionals or implicit fallbacks.
- Keep React components functional and use the established theme and typography tokens in
  `packages/ui` for both light and dark modes.
- Keep Electron preload APIs explicit and typed. Do not add a generic channel escape hatch or import
  Electron into shared renderer code.
- Never execute Pi extensions in a renderer.
- Never log credentials, authorization or pairing data, prompt bodies, file contents, provider
  responses containing user data, or complete environment values.
- Use path containment based on canonical filesystem boundaries, not string prefixes alone.
- Use locks and atomic replace for shared configuration or metadata writes; make concurrent edits
  and crash recovery testable.
- Preserve user changes and unrelated work in a dirty tree. Do not use destructive Git cleanup as a
  convenience.

## Commits and pull requests

Use short, imperative commit subjects with a conventional type prefix when it helps, for example:

```text
feat: add Pi package capability diagnostics
fix: preserve session cwd across worktrees
docs: explain cloud rollback guarantees
```

A pull request should let a reviewer verify the result without reconstructing your investigation.
Include:

- the user or maintainer problem and resulting behavior;
- non-goals when nearby scope could be ambiguous;
- affected packages, runtimes, persisted formats, external contracts, and trust boundaries;
- exact automated and manual checks, including their results;
- meaningful risk, failure, cleanup, rollback, compatibility, and security considerations;
- current visual or empirical evidence when applicable;
- anything you could not verify.

Keep the branch up to date without rewriting other contributors' work. Resolve conflicts by
re-evaluating behavior and ownership, not by mechanically choosing one side of the diff.

## Non-code contributions

You can also help by:

- reporting a reproducible bug or confusing workflow;
- testing on another operating system, browser, architecture, or display size;
- improving setup, deployment, accessibility, localization, or troubleshooting documentation;
- verifying a maintained Pi extension update and recording compatibility evidence;
- proposing a clearer Pi-native interaction or plugin configuration surface.

## License

By submitting a contribution, you agree that it may be distributed under Varin's
[GNU Affero General Public License v3.0](../LICENSE) (`AGPL-3.0-only`) and that imported third-party
material retains the notices required by [Third-party notices](../THIRD_PARTY_NOTICES.md).
