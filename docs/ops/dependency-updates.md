# Dependency maintenance

Dependency reports, consumer checks, and lockfile updates.

[Development guide](../development.md) · [Operations index](README.md)

## Dependency update review

[`scripts/audit-dependencies.mjs`](../../scripts/audit-dependencies.mjs) owns the current advisory exceptions and their behavior checks. The dependency audit prefers published fixes. The remaining pinned local repairs for `braces`,
`http-cache-semantics`, and `sprintf-js` must pass behavior checks through their actual installed
consumers before their version-based advisories are excluded. `sprintf-js` has no published fixed
version; its patch keeps numeric precision within the ECMAScript-supported range while preserving
normal formatting. Every other advisory still fails the audit.

Zod is pinned to the published 4.6.7 fix for bounded-collection validation. MCP and the other
consumers already support Zod 4; published Bash language server 5.8.1 still depends on Zod 3.
Its runtime-only patch backports the [upstream Zod 4 configuration migration](https://github.com/bash-lsp/bash-language-server/commit/320b3fc77806ec53f220d0dbae767b98b3991f5c),
preserving nested defaults and omitted initialization options rather than overwriting environment
settings. Varin bundles the CLI JavaScript, not Bash's TypeScript declarations; the patch does not
claim to migrate that unused public declaration surface. Remove the patch when upgrading to a
published Bash release containing this migration, retaining the real configuration and packaged-LSP
regressions. Do not replace it with an unreviewed snapshot of upstream main.

The Host uses body-parser 2.4 with its supported qs range; compressed-body regressions run through
the installed Express parser and Host middleware, including decoded limits and trailing-byte cleanup.
Electron 44.9.3 includes the compromised-intermediate-certificate mitigation. Notification HTTPS
authentication and event streams use standard certificate verification: untrusted/self-signed
endpoints must establish trust rather than relying on the former verification bypass.

Dependabot checks Bun, Cargo, and GitHub Actions dependencies once every 24 hours at 00:00 UTC,
including weekends, with no additional release cooldown. Discovery is scheduled, not an upstream-release
webhook, so GitHub's
queue and the configured open-PR limit can delay proposals. Major versions remain visible; for example,
an `@types/node` major upgrade should be evaluated with the actual Node runtime instead of being hidden.

Dependabot PR jobs in CI, Docker PR verification, and dependency reports share one job-level
`varin-dependabot-background` concurrency group with `queue: max`. This keeps a batch of Bot updates
from occupying multiple runners at once, while preserving queued checks for different PRs. The
existing per-PR workflow cancellation still supersedes obsolete checks. Human PRs, main, release tags,
and desktop/npm releases use separate groups and retain parallel execution. This reduces Bot runner
contention; GitHub does not expose strict workflow priority or preemption. Dependabot's platform-generated
update jobs are outside these repository workflow groups, so this does not serialize dependency discovery.

The [dependency report workflow](../../.github/workflows/dependency-report.yml) runs when a Dependabot PR
opens, reopens, changes head, or edits its description. It updates one report comment with version
ranges, upstream excerpts, and migration hints found in the text. Shared release notes are deduplicated;
missing or truncated material is called out. The run's `dependency-report` artifact contains the report
and original API data. Existing PRs can be covered with `gh workflow run dependency-report.yml -f pull-request=NUMBER`.
A scheduled check with no update produces no report message. Rebases, title edits, and workflow reruns
leave the existing comment untouched when dependency versions and collected material are unchanged.

This is automatic evidence collection, not model-generated compatibility analysis. When reviewing an
upgrade, use upstream release/changelog/compare links to cover the entire current-to-target interval,
including intermediate releases; summarize the relevant features, fixes, removals, runtime requirements,
and changes to Varin's actual consumers. Separate confirmed upstream facts from inferred project impact
and give a recommendation with any concrete migration work. Do not interpret missing release notes as
no changes, or a patch/minor version as proof of compatibility. Keep these judgments distinct from CI
results. Production dependency changes may also need the cloud runtime lockfile refreshed; see
[Cloud deployment](cloud-deployment.md#building-the-canonical-runtime-directly).

## Native consumers and production locks

The runtime, Host, PDF engine, model transports and MCP owner now consume their dependencies directly.
Follow current package manifests and lockfiles rather than old SDK adaptation histories. Protocol-specific
behavior remains covered by the corresponding Rust/provider and Host consumer tests; a successful install
or type check does not establish native loading, PDF rendering, account authentication or network behavior.

The report only runs default-branch code and reads PR metadata; it neither installs PR dependencies nor
executes PR code or project tests. `node --test scripts/dependabot-report.test.mjs` exercises its parsing.

When production dependencies change, prepare the relevant outputs, refresh
`scripts/cloud-runtime.bun.lock` through `bun run update:cloud-runtime-lock`, and review the resulting graph.
Native executables and assets need target-platform validation; historical SDK patches and verification
batches remain in Git rather than acting as current installation instructions.
