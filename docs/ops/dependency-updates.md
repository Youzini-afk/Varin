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

### Dependabot 候选策略

[配置](../../.github/dependabot.yml)按升级单元组织候选，不以减少 PR 数量为目标：

| 生态 | 检查时段（UTC） | 新版本发布后的冷却期 |
| --- | --- | --- |
| Bun `/` | 每天 00:00，含周末 | patch 1 天、minor 3 天、major 7 天；其他情况 3 天 |
| Cargo `/kernel` | 每天 01:00，含周末 | patch 1 天、minor 3 天、major 7 天；其他情况 3 天 |
| GitHub Actions `/` | 每周一 02:00 | 3 天；该生态不支持 SemVer 分档冷却 |

冷却按发布年龄计算，不是 PR 打开后的审批等待；定时检查也不是上游发布 webhook，GitHub 排队仍可能延迟。
三个生态均设置 `open-pull-requests-limit: 1000000`，按[官方建议](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#open-pull-requests-limit)
用足够大的整数实现实际不设数量预算，而非真正无限或平台最大值。省略此项会恢复默认 5，`0` 会禁用版本 PR。

React、PDF.js/canvas、CodeMirror/Lezer、Vite、Vitest、ESLint、Electron、Capacitor、SQLite、
tree-sitter/Wasmtime/Cranelift 和 artifact actions 按各自联动边界分组，允许共同评审 major，
但不假定同组最新版一定兼容或 major 编号相同。纯开发工具与普通库的 minor/patch 分开合批；
认证、网络、原生、编译器和已知高风险 0.x 依赖从普通批次排除，未匹配的升级仍单独提议，并非忽略。
规则按首次匹配生效；包名 pattern 不能自动识别所有 0.x 版本，新增依赖需按实际消费者判断归属。

`triviumdb-upgrade-0.8` 是旧格式迁移读者，不能随当前 `triviumdb` 一起升到最新格式线；
当前 [Bun updater 跳过 `npm:` 别名要求](https://github.com/dependabot/dependabot-core/pull/15850)，
它的 0.8 版本线由维护者固定和审阅，分组排除不是别名维护保证。所有非联动 major 保持可见，
例如 `@types/node` 应连同实际 Node runtime 评估。保留默认自动 rebase，不开启自动合并。

安全更新不受上述常规版本冷却或 PR 数量预算约束；不改变告警/通知设置，也不把独立安全修复塞进大组。
[官方生态矩阵](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories)
目前列出的 Bun 不支持 Dependabot security updates，不能承诺它有即时安全 PR 兜底；已识别的紧急修复应主动处理，
不等待常规冷却或每周批次。每周审阅候选并记录具体迁移阻塞，不通过永久屏蔽整个包或所有 major 清理列表。

### PR 验证与报告

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
