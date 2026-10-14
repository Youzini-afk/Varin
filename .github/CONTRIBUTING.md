English | [简体中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-CN.md) | [繁體中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-TW.md) | [Français](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.fr.md) | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# Contributing to Varin

Contributions to the runtime, desktop and remote surfaces, extensions, documentation, accessibility
and platform support are welcome. This guide covers the public contribution workflow.
[AGENTS.md](../AGENTS.md) contains repository rules; the [development guide](../docs/development.md)
covers setup, commands and verification, and [architecture](../docs/architecture.md) explains module ownership.

## Before you begin

- Read the [Code of Conduct](CODE_OF_CONDUCT.md).
- Search existing issues and pull requests before starting duplicate work. Use
  [GitHub Issues](https://github.com/Youzini-afk/Varin/issues) for reproducible bugs, feature proposals
  and focused technical discussions.
- Report vulnerabilities privately through [Security](SECURITY.md). Keep exploit details out of
  public issues, pull requests, logs and screenshots.
- For substantial product or architecture changes, discuss the intended user outcome and affected
  boundaries early. A prototype can help resolve a concrete design question.

## Working on a change

Read the owning implementation, its consumers and the nearest README or DOCUMENTATION before editing.
Keep the change focused and preserve unrelated work. Follow existing code style and shared UI components.

Pi is the default conversation runtime. The opt-in Rust Agent runtime has its own history and execution
owners; both use shared Host services. Follow the actual owner described in the architecture rather than
copying state into another layer. Changing the default runtime or migrating user assets needs explicit agreement.

Use public extension interfaces and preserve plugin-owned configuration and data. Privileged operations
belong in the trusted Host, never in a renderer. Check the applicable [security](../docs/security.md)
and [extension](../docs/extensions.md) boundaries, and never log credentials or private user content.

Obsolete internal formats do not require compatibility readers or automatic migration machinery.
Unsupported stores must leave existing assets intact. Workspace files, Git history, native Pi data and
external configuration remain user assets; current-format durability and recovery still apply.

## Documentation

Code, types, schemas, tests and package scripts establish current behavior. Documentation explains
responsibilities, mechanisms, constraints and useful design reasons; Git preserves history. Update the
relevant current explanation when behavior changes. The [documentation index](../docs/README.md)
locates the owning document; [AGENTS.md](../AGENTS.md) describes how to handle active designs and plans.

Public user documentation, the root README, this guide and the security policy use English as their
source language. Keep applicable existing translations synchronized when changing facts, commands,
security guidance or links. Localized root documents retain their language navigation.

Main engineering documents use Chinese. Source-adjacent and package documents keep their established
language; they do not need parallel translations. The public documentation language convention does
not change this engineering convention.

## Verification

Choose checks for the behavior and consumers affected by the change. Use the nearest `package.json`
and the [development guide](../docs/development.md) to find the appropriate commands.

Reuse meaningful existing checks. Add a regression test when it protects important behavior or a
reproduced failure; a new test is not required for every change. Remove obsolete or redundant checks.
Shared contracts need evidence from their consumers, and packaging or platform claims need the relevant
runtime. Type checking alone does not prove those behaviors.

For UI changes, use screenshots or recordings when they help verify the result, covering the layouts,
themes and states affected. Support performance claims with representative measurements. Report what
ran and what remains unverified. Broaden verification when a new failure or unresolved risk warrants it.

## Commits and pull requests

Use concise commit subjects describing the change. A pull request should explain the problem, resulting
behavior, relevant checks and any material limitations. Include affected ownership or external contracts
when they help the reviewer understand the change. Scale the detail to the work.

Keep the branch current without rewriting other contributors' work. Resolve conflicts by checking the
intended behavior and state owner, rather than mechanically choosing one side. Preserve unrelated user
edits and avoid destructive Git cleanup.

Bug reports, documentation improvements, translation updates and platform observations are also useful
contributions; include the environment and reproduction steps relevant to your report.

## License

By submitting a contribution, you agree that it may be distributed under Varin's
[GNU Affero General Public License v3.0](../LICENSE) (`AGPL-3.0-only`) and that imported third-party
material retains the notices required by [Third-party notices](../THIRD_PARTY_NOTICES.md).
