# Varin built-in extensions

This package contains the browser-safe manifests for Varin's built-in extensions and the immutable Node runtimes used by brokered Host extensions.

`varin.builtin.computer` provides the ordinary native single-call Computer tools. Its shared
`COMPUTER_TOOL_DECLARATIONS` supplies the product manifest, tool directory and Host argument decoder;
the immutable `host.cjs` uses SDK `provideTool` and the reviewed `computer.use` capability. The original
ComputerService retains desktop assignment, physical control and action receipts. Enabled-by-default
distribution does not bypass capability review, selected tool configuration or actual Computer settings.
The saved execution binding fixes its default desktop and is restored unchanged after reconnect.
The same declaration exposes request/access/grant/deny and durable request Wait for existing
child tasks with or without a file source. Resource assignment does not expand their frozen callable
tools. Trusted handback continuation and persistent Computer scripts remain pending. See the [Computer owner](../web/application-host/lib/computer/DOCUMENTATION.md).

The lazy brokered `varin.builtin.retrieval-structured`, `varin.builtin.retrieval-keyword`, and
`varin.builtin.retrieval-semantic` packages
provide `varin.retrieval.plan@1`. The structured declaration is the native retrieval distribution
default; the ordinary extension service-routing picker can explicitly select keyword-only or
keyword+structure+semantic before activation. They declare only stage choices and receive no
filesystem/model grants. Selecting the semantic declaration uses the native owner's explicitly
configured remote embedding backend and published reader, with no local or paid fallback. Their
immutable `host.cjs`, manifest and fingerprint ship through the same package-root map and artifact
lifecycle as other built-ins. See [native retrieval authoring](../../docs/ops/varin-extension-authoring.md#native-retrieval-plans).

`VARIN_BUNDLED_LANGUAGE_SERVERS` is the stable provider catalog consumed by Host status views. Its `id` values are workspace language provider ids, and `languageIds` are the LSP language ids handled by each provider. A catalog entry means the provider is shipped; its runtime status still comes from `workspace.language` and can be inactive until a matching workspace is opened.

The build writes these language server assets to `dist/builtin-packages/language-servers`:

- Pyright for Python.
- The extracted VS Code HTML, CSS/SCSS/LESS, and JSON/JSONC servers.
- YAML Language Server with its localizations.
- Bash Language Server with its Tree-sitter grammar.

Each brokered entrypoint launches the immutable runtime with `process.execPath`; it never installs a server at runtime. The packaging smoke copies a completed distribution to a temporary directory and speaks LSP over stdio to verify initialization, document open, and symbols or diagnostics without resolving the workspace's `node_modules`.
