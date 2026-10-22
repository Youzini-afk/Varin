# Structure sources

The Application Host resolves language/grammar recipes and projects native syntax facts.
Rust kernel compute owns workspace bytes, Tree-sitter parsing and query execution. Production
uses the Tree-sitter provider only; there is no LSP fallback or background symbol-catalog scan.

## Ownership and source identity

`languageIdForPath` and the committed grammar manifest define language identity.
Live requests use an admitted root; fixed requests retain their original pin; an activated
fixed-source execution view is resolved by the original Source owner. Path equality alone
does not authorize another source.

Results carry the actual revision and content hash. A stale or failed parse is distinct from
an empty outline. Cancellation reaches the native compute/parser job; closing a UI observation
does not release a still-running original reader. Native recipe caches are keyed by actual
grammar/query identity, not by an unversioned filename.

## Consumers

`createStructureSource` exposes outline, hit classification, literal-call shapes and imports
when the selected recipe supports them. Generic provider composition remains in this facade,
but startup registers only `createTreeSitterStructureProvider`.
Imports and literal strings are syntax observations; this module does not maintain a
persistent repository graph or rank evidence.

The common `file_read` tool can select a unit by line or exact symbol name. Native symbols
include name, kind, full byte/line span and signature text with its real line range.
An enclosing-line request selects the smallest matching unit. Symbol ambiguity returns
candidates. Body reads verify the same content hash and can continue by byte offset and
revision. Unsupported/failed parsing, an uncovered line or an incomplete syntax
node returns ordinary text and an explicit reason. The default line fallback
includes 20 preceding and 60 following lines; it is a reading window, not an
input limit. `nextRead` continues the plain file. A unit-relative continuation
never silently changes into a file-relative read. Ambiguous selections retain
their candidates, including several declarations sharing the same line/span.
There is no signature/focus-only slicing policy that silently substitutes a fragment for a
requested complete function.

IDE language services keep their own consumer and permission boundaries. Agent/Bot
directories, disclosure and profile capability choices expose no `language_*` tools.
Syntax analysis does not install or start a language server.

## Grammar resources

Bundled grammars and their tags queries live in `runtime/`; their build manifest and
`languages.ts` determine available languages and capabilities. The Host copies these assets
to its server bundle; Rust verifies registered recipe identity and parses the actual source.
There is no Host parser fallback for workspace contents.

The current bundle covers JS/JSX, TS/TSX, Python, Go, Rust, Java, C/C++, C#,
Kotlin, Swift, Dart, Ruby, PHP, Bash, PowerShell, Lua, Scala, Elixir, Zig,
Solidity, OCaml, HTML/CSS, Vue/Svelte, JSON/YAML/TOML/INI, HCL/Terraform,
Markdown and XML. Vue/Svelte return complete script/style/template elements;
embedded JS/TS is not independently parsed. Markdown units are sections, XML
units are elements. Unlisted languages retain ordinary search/read access;
Fish and Zsh are not misidentified as Bash.

Upstream navigation tags may cover a declarator rather than its body. Native
unit normalization retains enclosing declarations, export/template/decorator
wrappers, adjacent attributes/docs and Dart's separate signature/body siblings.
Malformed units are marked incomplete so they cannot masquerade as full code.
The manifest may select a reviewed `bundledQueryFile` with its own digest.
Pinned standalone upstream wasm releases are supported alongside npm archives.
Both the grammar and query must load successfully before bundling.

Parsing is on demand. Compiled grammars/queries are reused inside native compute
workers; their cold compilation is separate from the per-file parse budget.
Current reads parse the requested file afresh and do not retain incremental trees.

On-demand grammar packs use the committed `grammar-packs.json` digests. Explicit installation
writes `structure-grammars/sha256/<hash>.wasm` and the original index. User-supplied wasm is
marked unverified. Host `web-tree-sitter` is retained only for install-time ABI checks.
Unreadable grammar indexes remain errors, rather than an invitation to overwrite them.

The existing parse budget guards a pathological native parse; it is independent of model
context and investigation duration. A missing grammar or exhausted parse reports its actual
status, allowing the caller to read plain source. Tests of real parsing use their own
explicit budget.

See [retrieval](../../../../../docs/retrieval.md) for the model-facing contracts and
[language services](../lsp/DOCUMENTATION.md) for the optional IDE consumer.
