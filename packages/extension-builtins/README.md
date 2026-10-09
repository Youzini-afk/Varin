# Varin built-in extensions

This package contains the browser-safe manifests for Varin's built-in extensions and the immutable Node runtimes used by brokered Host extensions.

The lazy brokered `varin.builtin.retrieval-structured` and `varin.builtin.retrieval-keyword` packages
provide `varin.retrieval.plan@1`. The structured declaration is the native retrieval distribution
default; the ordinary extension service-routing picker can select keyword-only before either package
has activated. Both declare only stage choices and receive no filesystem/model grants. Their
immutable `host.cjs`, manifest and fingerprint ship through the same package-root map and artifact
lifecycle as other built-ins. See [native retrieval authoring](../../docs/ops/varin-extension-authoring.md#native-retrieval-plans).

`VARIN_BUNDLED_LANGUAGE_SERVERS` is the stable provider catalog consumed by Host status views. Its `id` values are workspace language provider ids, and `languageIds` are the LSP language ids handled by each provider. A catalog entry means the provider is shipped; its runtime status still comes from `workspace.language` and can be inactive until a matching workspace is opened.

The build writes these language server assets to `dist/builtin-packages/language-servers`:

- Pyright for Python.
- The extracted VS Code HTML, CSS/SCSS/LESS, and JSON/JSONC servers.
- YAML Language Server with its localizations.
- Bash Language Server with its Tree-sitter grammar.

Each brokered entrypoint launches the immutable runtime with `process.execPath`; it never installs a server at runtime. The packaging smoke copies a completed distribution to a temporary directory and speaks LSP over stdio to verify initialization, document open, and symbols or diagnostics without resolving the workspace's `node_modules`.
