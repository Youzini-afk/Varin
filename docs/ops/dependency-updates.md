# Dependency maintenance

Status: contributor operations — dependency reports, SDK seams, and lockfile updates.

[Development guide](../development.md) · [Operations index](README.md)

## Dependency update review

[`scripts/audit-dependencies.mjs`](../../scripts/audit-dependencies.mjs) owns the current advisory exceptions and their behavior checks. The dependency audit prefers published fixes. The remaining pinned local repairs for `braces`,
`http-cache-semantics`, and `sprintf-js` must pass behavior checks through their actual installed
consumers before their version-based advisories are excluded. `sprintf-js` has no published fixed
version; its patch keeps numeric precision within the ECMAScript-supported range while preserving
normal formatting. Every other advisory still fails the audit.

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

The bundled Pi packages are pinned to 1.0.4. Review its
[release](https://github.com/earendil-works/pi/releases/tag/v1.0.4) and
[coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/CHANGELOG.md)
alongside the previous-to-target interval. Host integration patches live in `packages/pi-host/patches`
and ship with that package. Bun applies them to bundled dependencies; the selected external SDK loader
applies the same hunks in memory, accepts an already adapted source and rejects a changed required seam.
Never patch a user's external installation or copy its native configuration into another authority.

The October 6 dependency integration rebases the three Pi patches against the published 1.0.4
files, preserving Varin's execution scheduling, tool exclusions, Responses parsing, system sections
and native MCP ownership. Upstream tool-pattern and hidden-tool behavior remains intact. Project
MCP overrides write their actual project file and keep explicit values when overriding global
defaults. The SDK's new SSH environment API does not by itself add a Varin SSH workspace UI.

The same integration updates cron-parser callers to `CronExpressionParser.parse`; supplies PDF.js 6
with file URLs, WASM/ICC assets and an explicit render canvas; and retains CONNECT proxy routing
after Undici 8 changed its HTTP forwarding default. SnapDOM 3 uses its own declarations instead of
Varin's old ambient types. Its existing clone plugins, capture/export calls and DPR options remain
supported. The NSIS extraction hook is rebased onto app-builder-lib 26.17.0. Both Bun lockfiles must
describe the resulting graph, including updated overrides; successful installation or type checking
does not replace native import, provider, PDF rendering and transport checks.

The Responses parser seam consumes reasoning deltas, completed summary/content parts and terminal
response output. Completed parts replace their streamed prefix rather than duplicating it; encrypted
reasoning remains in the native replay signature even when no visible summary is returned.

Responses tool conversion explicitly sends non-strict mode for the default/null
provider setting, including the Codex Responses path, so optional fields stay
optional. The standard Responses provider enables the strict-parameter protocol
by default so it actually sends that explicit `false`; an explicit provider
compatibility override is still honored. Tools that request strict constrained sampling still use
Pi's strict schema conversion. Minimal dispatch/document/web/history calls are
checked through provider conversion and native tool execution.

SDK upgrade checks exercise real native sessions: canonical system/context-edit projection, physical
virtual-model routing, compaction worker scope, top-level and codemode child permissions/scheduling,
native MCP status/config mutations and replacement by a user extension, and atomic message-queue edits,
promotion and delivery with grouped instructions/attachments. Node/tsx runs these native SDK
fixtures; UI consumers use Vitest. Controlled local MCP/provider fixtures need no paid request or browser.
Production packaging must include the Host patch directory and native QuickJS worker/WASM dependencies,
and refresh `scripts/cloud-runtime.bun.lock` after the final dependency/patch change.

The MCP adaptation also exports the lazy connection runtime and adds an embedding-owner seam
for the Application Host. Pi delegates through that seam; native execution leases the same
connections. The connection's asynchronous pre-dispatch guard must survive upgrades, including
reconnect paths. MCP OAuth binding metadata belongs to the existing credential state and must
remain stable across token refresh while changing for a new authorization grant. See the
[shared owner contract](../../packages/pi-host/src/mcp-authority.md).

Native MCP is the default without an external package. The former foundational-package provisioning
and restore APIs have been retired; already installed adapters remain ordinary Pi packages. Package
mutations retain broker serialization and a shared agent-directory filesystem lock. The UI preserves
native connecting state, refreshes the authoritative catalog after actions, and exposes per-tool
access overrides. Project overlays expose only the fields accepted by Pi's overlay schema.

The 1.0 upgrade retains stable AgentSession and rebases the existing Host seams. The additional codemode
`docsReference` option points to `pi_docs`, which reads actual assets from the selected SDK independently
of workspace scope/machine placement. Keep `docs/codemode.md`, `docs/models.md` and `docs/mcp.md` in the
installed runtime. Native image fixtures mock only the paid provider response and exercise the real
sandbox, reference reader, image journal and protocol projection. UI checks cover zero-token cost and
combined model/tool receipts. The experimental durable runtime assessment is recorded in
[Pi durable-runtime assessment](../reviews/pi-durable-runtime.md#pi-10-durable-runtime-assessment); it is not part of this production dependency change.

The report only runs default-branch code and reads PR metadata; it neither installs PR dependencies nor
executes PR code or project tests. `node --test scripts/dependabot-report.test.mjs` exercises its parsing.

## MCP oversized-frame failure

The pinned `@earendil-works/pi-mcp` patch preserves the dependency's existing 16 MiB stdio
message limit. Exceeding that real framing budget emits typed `McpMessageTooLargeError`
(`mcp_message_too_large`), immediately rejects only that client's pending calls, and closes its
transport. Ordinary transport errors and benign late-response diagnostics do not trigger this path.
A dispatched tool retains unknown effects and is never replayed automatically; other MCP servers
and the kernel remain available. The patch does not claim to preserve oversized response content.
Keep this patch in both workspace and cloud-runtime locks, and verify real non-ASCII stdio frames,
client closure, no replay and unaffected independent work after dependency updates.
