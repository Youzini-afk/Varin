# Structure sources

Application Host module for syntax-shaped facts used by explore (and later by
hit classification, connection edges, and the knowledge graph). It does not run
in a renderer and is not a language-server replacement.

## Ownership

- Language identity is `languageIdForPath` from `@varin/protocol`. This module
  does not keep a third extension table.
- Tree-sitter workspace parsing is a Rust-kernel compute responsibility. The
  Host resolves a language spec, registers the grammar/query recipe, validates
  bounded records, and projects them into `StructureProvider` DTOs; it does not
  keep a second parse tree or source-body cache.
- Text binding for the LSP provider reuses `createLanguageViewBinder`. Explore
  calls it with `text: "input-context"` (this turn's fixed draft, otherwise disk).
  A dirty path whose draft is unavailable does not fall back to disk.
- Revisions are hard: every request names a revision, every result names the
  revision it used. A mismatch is `stale`, never a silent reuse of an older
  outline on newer text.

## Provider contract

`StructureProvider` exposes four operations. Capability flags say which ones a
provider can actually answer for a language:

| Operation | Meaning | Providers |
| --- | --- | --- |
| `outline` | Named units with signature and full span | tree-sitter (TS/TSX/JS/JSX/JSON), then LSP `documentSymbol` |
| `classifyHits` | Hit line → name / body / string / comment | tree-sitter (not LSP) |
| `literalCalls` | Call + string-literal shapes | tree-sitter when the spec has `literalCallQuery`; `StructureSource` fans out like outline (D-106); graph write classifies `connects` vs `associates` |
| `imports` | Import sources | tree-sitter when the spec has `importQuery`; same fan-out; specifier strings are written as `imports` edges |

Statuses stay distinct: `ready`, `empty`, `unavailable` (cold or missing
runtime), `unsupported` (no language, or no `documentSymbolProvider`), `stale`,
`failed`, `cancelled`. They must not collapse into one successful empty list.

`createStructureSource` tries configured providers in order. The first `ready`
outline that covers every supplied hit line wins immediately. `empty`, or a
`ready` outline that misses a hit, does not hide a later provider: the next
call is `warmOnly` so a cold language server is not started (D-099). The first
provider's `unavailable` still allows a cold start on the next one. A later
`ready` outline replaces the earlier one; results are not merged.
`literalCalls` and `imports` use the same cancelled / empty / warmOnly /
unavailable rules without hit-line coverage. When no configured provider
declares the capability, the facade status is `unsupported`, not `failed`
(D-106). LSP still reports `unsupported` for those two operations.

What the outline contains is deliberately wider than what slicing will use.
Containers, definition bindings, and module- or class-level value bindings are
all outlined; the last group carries kind `variable` so `export const
DEFAULT_BYTE_BUDGET = 24576` is a findable catalog name. Function-local
bindings stay out, matching what `documentSymbol` reports. Slicing narrows the
outline again through `isStructureContainerKind`, so D-098 is unaffected by the
wider outline (D-113).

`literalCalls` only reports the shape it saw. Deciding which of those are
association candidates needs the graph, because plan 3.11 marks a *same-name*
string as a candidate: the classifier in `connections.ts` splits allowlisted
callees from the rest, and the knowledge runtime then drops any non-connection
literal that is not already a confirmed connection value somewhere (D-109).
Without that second gate every `it("…")` and `join("…")` becomes a graph node.
The calls are retained as compact metadata on the current file row, bound to
its generation and revision. Once the scan has committed all extracted
`connects`, the store can create or remove matching relation rows from that
metadata alone; it does not re-read or re-parse the source, and a newer file
generation replaces the metadata automatically.
An explicit catalog rescan reconciles deleted paths only after a complete Host
enumeration and Documents missing observations. Store deletion checks the old
revision/generation and cancellation inside its write queue; an incomplete or
unknown enumeration preserves the graph, and recreated paths are recollected.

## Slice

Slice units are **containers**: function, method, constructor, class, interface,
enum, module/namespace, type, struct, package (D-098). Ordinary value bindings,
fields, method signatures, and enum members are names inside a container, not
the unit. A hit on `const needle = 1` inside `function big` selects `big`.
`const foo = () => {}` / `const C = class {}` stay their own units because the
tree-sitter provider emits them as `function` / `class` after inspecting the
initializer.

`sliceStructureWindows` turns an outline plus `focusRanges` into explore windows.
A lexical hit line is one origin (`lexical-hit`); a semantic or graph range is
another. Empty only when there are no focus ranges. `proposeSymbolSliceSchemes`
lists presentations and UTF-8 costs; `renderSymbolSliceScheme` emits one. This
delivery ships a single scheme (signature + focus blocks + omission marks).

- Inclusive span ≤ `SMALL_STRUCTURE_SPAN_LINES` (24; one typical editor
  viewport, D-093) → the whole unit.
- A unit whose signature spans the whole unit carries no body of its own, so it
  is padded to at least the ±3 window around each hit (D-102). Container kinds
  alone do not prevent this: `documentSymbol` types an interface call signature
  as `method`, so the smallest container can be one line. Units that do have a
  body stay exact.
- Larger → signature + hit block (±3 clipped to the unit) + explicit omission
  markers that include a full-unit `read path:start-end` entry.
- Missing, empty, unsupported, unavailable, failed, cancelled, or stale
  outlines → the existing ±3 line window. Stale outlines are not applied to the
  current text. A value-binding hit inside a container is never a one-line
  unit.

That ±3 fallback is a runtime degradation, not a compatibility layer for old
callers.

Tree-sitter capabilities are derived from `TREE_SITTER_LANGUAGE_SPECS` in
`languages.ts`. A missing spec, or a spec without `importQuery` /
`literalCallQuery`, is `unsupported` (D-099 / D-106 already fan that out).
Do not hard-code the four flags.

## Tree-sitter coverage

The Host bundles the runtime plus wasm and an outline query for the common
language ids in the committed grammar manifest: `typescript`,
`typescriptreact`, `javascript`, `javascriptreact`, `json`, `python`, `go`,
`rust`, `java`, `c`, `cpp`, `csharp`, `kotlin`, `ruby`, `php`, `shellscript`,
`css`, `html`, `yaml`, and `toml`. JS and JSX share
`tree-sitter-javascript.wasm`; each other id has its matching grammar file in
`runtime/`. The query files are checked in beside the wasm so a production
Host, cloud server, and Electron app have the same structure behavior without
an install click or network access.

### TypeScript / TSX

Covered as outline units: function / generator / class / abstract class
(including named `export default` and anonymous `export default class {}`),
interface, type alias, enum, `method_definition` (class and object-literal
methods), `function_signature` (`declare function`), `internal_module` /
`module` (`namespace`, `declare namespace`, `module`), and lexical / `var` /
public-field bindings whose initializer is a function, arrow, or class.

Covered as names only (classification, not slice units): ordinary
`const` / `let` / `var` value bindings, `method_signature` /
`abstract_method_signature`, and public fields with a non-definition
initializer.

Not covered: import aliases, enum members as units, interface members as units,
parameters, decorators, unnamed `export default abstract class {}` (the grammar
emits an error node), and a full grammar-node census. Arrow bindings
(`const beta = () => {}`, `export const gamma = () => {}`) and
`export default function` outline normally; they are not a coverage gap.

### JavaScript / JSX

Same outline and slice rules as TypeScript, minus types: no interface / type
alias / enum / `function_signature` / `abstract_class` / `internal_module`.
Fields use `field_definition`. Import and literal-call queries match the
TypeScript shape. Cold catalog scan includes `javascript` and `javascriptreact`
(D-115).

### JSON

JSON is sliced, not cataloged (D-114). Outline keeps top-level pairs and pairs
whose value is `object` or `array` (`kind: property`), plus object/array
nodes as slice containers. Caps: depth 8, 256 symbols; the document root is
always kept. `literalCalls` / `imports` are `unsupported`. JSON files do not
enter the cold catalog — key names are not what `searchSymbols` answers.

Native grammar runtimes are cached by the kernel from the registered recipe and
actual wasm digest. Parsing and query cancellation happen in the compute worker;
the Host never holds a live tree across an `await`. The Host submits the same
recipe path for bundled and user-installed grammars; Rust is the only parser
and query authority.

## Wiring

`createHarnessServiceHost({ structureSource })` is optional, same shape as
`lspNavigationServices`. Production `index.ts` installs the native tree-sitter
provider first, then the LSP provider (D-097). Explore consumes the interface
only; it does not call `documentSymbols` itself. Live files use
`KernelComputeService.directory`; captured Registry text uses fixed objects;
virtual Threads call the provider with a pin-bound compute function. Semantic
chunking uses native structural units and keeps only tokenizer-aware packing and
embedding decoration in TypeScript.

Runtime wasm and the corresponding tags queries live in
`lib/structure/runtime/`. Paths go through the same asar / asar.unpacked remap
as `extension-builtins` (D-096). The Application Host build copies the runtime
directory into `server/lib/structure/runtime/`; Electron unpacks its
`node_modules` tree, so the existing path remap reaches the physical wasm.
A missing or unloadable wasm/query is `unavailable`; explore then tries LSP or
the ±3 window.

On-demand grammars are listed in committed `grammar-packs.json` (publish-time
sha256, D-125). Install writes `{VARIN_DATA_DIR}/structure-grammars/sha256/<hex>.wasm`
plus `index.json`. `resolveStructureRuntimeFile` looks at the bundled
`runtime/` directory first and only then at the download store (D-126). Host
never starts a grammar download by itself; the settings page Install click is
the consent (D-124). User-supplied wasm uses the same store with
`source: 'user'` and stays `user-unverified` (D-123). Host `web-tree-sitter`
remains only as the install-time ABI admission probe. Production workspace
source is parsed by the kernel after `compute.grammar.register` verifies the
actual wasm/query recipe identity; there is no Host parser fallback.

An on-demand grammar gets its outline from the pack's own upstream
`queries/tags.scm`. `treeSitterTagsSpec` turns that query into a runtime
language spec: `tagsDefinitionKind` maps `definition.*` capture suffixes to
symbol kinds, unrecognized suffixes become `unknown` (catalog name, never a
slice unit), and `reference.*` produces nothing. Hit classification falls back
to matching node type names, which is a tree-sitter naming convention rather
than a per-language table. `literalCalls` and `imports` need hand-written
queries and stay off. Common bundled grammars whose npm packages do not ship
tags queries use the checked-in `runtime/*.tags.scm` query; the refresh script
compiles those queries against the published wasm as a build-time check. The
manifest's `tagsPath` / `tagsIntegrity` fields continue to describe only files
inside an on-demand tarball, and install verifies both digests. A pack that is
neither bundled nor shipped with a verified query installs a parser with every
structure capability off, and `LanguageSupportStatus` reports that distinctly
so the settings page does not show it as working (D-128).

`GrammarStore` treats only ENOENT as an empty store; a parse error or an IO
failure raises `GrammarStoreUnreadableError` rather than reporting nothing
installed, and `index.json` is written through a temp file and rename. The
language-support runtime turns that error into `grammarStore: 'unreadable'`
with per-language `unknown`, which disables install instead of inviting a
click that would overwrite real records (D-129).

`STRUCTURE_PARSE_BUDGET_MS` is passed to the native parser/query job. It is a
wall-clock runaway guard, not a latency target: a value near an ordinary file's
parse time can make a busy computation report `failed` and fall back to ±3
windows. Tests that assert a real parse pin their own budget rather than
inheriting the production value (D-102). An abort also reaches the native parse
callback rather than merely discarding a late Host result.

Hit classification (D-095) runs only after a file is materialized. Candidate
ranking before `readFile` is unchanged. `windowScore` then adds
`STRUCTURE_HIT_CLASS_SCORE` so a declaration name outranks the same token in a
comment or string.

A repeatable agent-view cold-start measurement lives in
`packages/web/scripts/structure-cold-start.ts` (`bun run --cwd packages/web structure:cold-start`).
It is not in the default test suite. Numbers go in `docs/status.md`;
do not turn them into speedup claims.
