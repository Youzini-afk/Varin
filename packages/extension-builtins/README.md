# Varin built-in extensions

This package contains the browser-safe manifests for Varin's built-in extensions and the immutable Node runtimes used by brokered Host extensions.

These declarations form the executable capability directory. Ordinary Agent requests expose a
stable native interface: `tool_describe` reads available namespaces or exact tool documentation,
and `tool_invoke` calls a tool by name and arguments through the original nested invocation
lifecycle. Detailed schemas are tool-result data, not additional model functions. Explicit tool
toggles compose with each owner's configuration readiness before a declaration is published.
`runtime_contract` covers service/UI contracts and package source; callable-tool documentation
belongs to `tool_describe`.

`varin.builtin.web` distributes ordinary `websearch`, `webfetch`, `document_read` and `materials` tools. The single
`WEB_TOOL_DECLARATIONS` feeds the manifest, tool schema and Host decoder; the immutable Host artifact
uses the existing `web.materials` capability. Search, egress, fixed snapshots and PDF parsing retain
their original Host/Storage owners. Source-less execution uses real Thread identity. Enabled-by-default
distribution does not bypass original call permission, accepted Web settings or material authorization.
The adapter supports URL/fixed-snapshot reads, scoped local/Experiment PDF sources and the original
material collection/share actions. Collection mutations retain their original Storage receipts; family
membership alone does not grant private material access. Reader-model prompts remain separate
integration work. See the [Web/material owner](../web/application-host/lib/harness/DOCUMENTATION.md).

`varin.builtin.research-discovery` distributes the ordinary `research_search` metadata tool through
`RESEARCH_DISCOVERY_TOOL_DECLARATIONS` and the `research.discovery` capability. Search, paper lookup
and relation pages use the original OpenAlex/Semantic Scholar owner; they do not download paper
content or acquire a file source. The accepted enabled setting and original per-call authorization
apply independently of Web settings. The artifact uses the same immutable package-root/fingerprint
pipeline. Fast decisions/reranking and reader-model prompts are not supplied by this metadata tool.

`varin.builtin.computer` provides the ordinary native single-call Computer tools. Its shared
`COMPUTER_TOOL_DECLARATIONS` supplies the product manifest, tool directory and Host argument decoder;
the immutable `host.cjs` uses SDK `provideTool` and the reviewed `computer.use` capability. The original
ComputerService retains desktop assignment, physical control and action receipts. Enabled-by-default
distribution does not bypass capability review, selected tool configuration or actual Computer settings.
The saved execution binding fixes its default desktop and is restored unchanged after reconnect.
The same declaration exposes request/access/grant/deny and durable request Wait for existing
child tasks with or without a file source. Resource assignment does not expand their frozen callable
tools. Trusted handback continuation and persistent Computer scripts retain their original lifecycle
owners; actual desktop/platform acceptance remains separate. See the [Computer owner](../web/application-host/lib/computer/DOCUMENTATION.md).

`varin.builtin.browser` exposes resource discovery, page management, observations, input and file transfer
through `browser.use`. The Application Host routes each operation to the selected browser resource and
its actual instance independently of the file workspace and frontend. Page and screenshot references
retain that complete binding; stale instances, unavailable capabilities and unknown action outcomes
are not redirected or replayed. Browser downloads and uploads transfer bytes through the original
browser and file/material owners, rather than interpreting one device's paths on another.
Electron continues to use its persistent profile, native input and page-scoped CDP transport with
Puppeteer Core; hidden/reparented UI views retain the same page identity. Other connections advertise
their actual capabilities. Host-principal authorization and accepted tool settings apply before access.

`varin.builtin.office` exposes `office_environment`, `office_read`, `office_write`, `office_render`, and
`office_export` through `office.files`. Format engines create editable documents and patch selected
OOXML parts; native Storage owns file revisions, conflicts and recovery receipts. Actual PDF conversion
and workbook recalculation use an available LibreOffice executable. The environment response exposes
component availability and reusable library paths without pretending a conversion occurred.

Native code retrieval uses the ordinary Agent tool/model/context owners, not the retired
keyword/structure/semantic stage-selection extensions. Those packages are no longer distributed;
existing routing rules remain user-owned and are not silently remapped. See [retrieval](../../docs/retrieval.md).

`VARIN_BUNDLED_LANGUAGE_SERVERS` is the stable provider catalog consumed by Host status views. Its `id` values are workspace language provider ids, and `languageIds` are the LSP language ids handled by each provider. A catalog entry means the provider is shipped; its runtime status still comes from `workspace.language` and can be inactive until a matching workspace is opened.

The build writes these language server assets to `dist/builtin-packages/language-servers`:

- Pyright for Python.
- The extracted VS Code HTML, CSS/SCSS/LESS, and JSON/JSONC servers.
- YAML Language Server with its localizations.
- Bash Language Server with its Tree-sitter grammar.

Each brokered entrypoint launches the immutable runtime with `process.execPath`; it never installs a server at runtime. The packaging smoke copies a completed distribution to a temporary directory and speaks LSP over stdio to verify initialization, document open, and symbols or diagnostics without resolving the workspace's `node_modules`.
