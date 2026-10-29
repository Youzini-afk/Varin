# Dependency maintenance

Dependency reports, consumer checks, and lockfile updates.

[Development guide](../development.md) · [Operations index](README.md)

## Dependency update review

[`scripts/audit-dependencies.mjs`](../../scripts/audit-dependencies.mjs) owns the current advisory exceptions and their behavior checks. The dependency audit prefers published fixes. The remaining pinned local repairs for `braces`,
`http-cache-semantics`, `sprintf-js`, and `deepmerge` must pass behavior checks through their actual installed
consumers before their version-based advisories are excluded. `sprintf-js` has no published fixed
version; its patch keeps numeric precision within the ECMAScript-supported range while preserving
normal formatting. Every other advisory still fails the audit.

`ip-address` is pinned to the published 10.7.5 repair for IPv6 link-local/NAT64 classification,
cross-family subnet comparisons, and unbounded parse/zone diagnostics. Checks resolve it through the
installed Claude SDK → MCP → Express rate-limit consumer, including ordinary IPv6 rate-limit keys.

`deepmerge` 4.3.1 has no published fix for [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
Its pinned source/CJS/UMD patch creates own data properties instead of invoking inherited setters in
both merge and target-copy paths. This keeps merged objects' prototypes intact without dropping data
keys; existing array, symbol and custom merge behavior is retained. The PWA build's actual Rollup
consumer and the distributed UMD entry must pass the poisoning and ordinary-merge regressions before
the version-based advisory is excluded. Replace this patch and its exception when a fixed upstream
release is adopted; production dependencies keep the same IP repair in the cloud runtime lock.

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

安全更新固定到已发布的 fast-uri 3.1.9、multer 2.5.0、serialize-javascript 7.1.3 和
image-size 2.0.3。审计从实际消费者解析依赖：通过 AJV 验证 URI 解析，通过 Workbox/Terser
验证脚本序列化，通过已安装的 Multer 验证请求清理后的异步过滤器回调；异常图片容器在有超时的
子进程中检查。正常图片嵌入使用真实 `createOfficeFile`，核对 PPTX 中的媒体字节与关系引用。

PptxGenJS 4.0.1 仍声明 image-size ^1.2.1，但已发布的 CJS/ESM 运行时不导入此依赖。
根 override 移除实际安装图中的易受攻击解析器，不为未使用的 v1 API 增加兼容适配；Varin 向
`addImage` 提供经校验的图片字节和明确几何尺寸。image-size v2 使用具名导出，并将文件读取
移到 `image-size/fromFile`；未来直接消费者必须使用此 API，不能假定 v1 的可调用导出/路径接口。
待 PptxGenJS 正式发布安全依赖范围后，经实际图片创建和开发/生产解析验证再移除 override。
两个 Bun 锁文件须保留相同修复；发布 CI 还负责完整 staged production 布局及打包原生运行时的验收。

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
