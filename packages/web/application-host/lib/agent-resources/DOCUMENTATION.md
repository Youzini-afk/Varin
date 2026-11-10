# Agent instruction and skill resources

This module owns read-only interpretation of already admitted instruction/configuration/skill assets.
It is not a settings writer, trust store, package installer, file authority, runtime, or generation database.
The entry point is `createAgentResourceAuthority()` in `authority.ts`.

## Current delivery boundary

The native Thread path uses this owner through `kernel/thread-resource-scope.ts`,
`thread-context.ts`, and the private `resource_read` owner. Prepared bytes live in the existing
ContentStore-backed ContextCheckpoint. ModelStep and policy calls retain the exact checkpoint they
selected; a resource refresh publishes by revision without changing an in-flight call.

Native explicit `/skill` input activation uses this same owner. Resources share the native
`AgentSettingsService` transaction and `ProjectTrustService` admission. This module never executes
package code, installs packages, invokes a model, or writes settings. Old Pi assets are not read or imported.

The settings prompt preview reads current resource sections independently of tool metadata. Its tool
tab loads the Rust built-in declarations, selected extension declarations and existing MCP directory
through `memory/prompt-tool-catalog.ts`; opening it does not prepare tool executors or connect servers.
This is a settings catalog, not a claim that every listed tool will be selected in a Run. Conversation
scope uses that branch's saved launch selection, including its exact MCP and extension schemas.
Tool descriptions and input schemas stay separate from editable system text and are never saved as
personalization overrides.

## Two operations

- `prepare(admittedScope, signal)` returns `ResourceResult<{ snapshot: PreparedAgentResources }>`. The
  candidate contains selected SYSTEM/APPEND references, scoped instruction chains, skill metadata,
  configuration identity, captured bodies, observed dependencies, and diagnostics. It publishes nothing.
- `read({ snapshot, readers }, request, signal)` handles `skill(resourceId)`,
  `skill-resource(resourceId, relativePath)`, and `instruction-scope(targetPath, targetType?)`. A target is
  interpreted as a file unless `targetType` is `directory`. Readers are temporary, already-authorized
  handles supplied by the consumer, never selectors supplied by the model.

`PreparedAgentResources` is frozen JSON data. `capturedFiles` is a publication payload and includes the
SKILL.md bytes already read for YAML metadata. It must not be included in the model metadata prompt.
A skill read reuses those exact bytes; it does not reread a live pathname. `readers` in the snapshot is only
an identity/consistency declaration, not a closure. The native caller stores this typed payload inside the existing ContentStore checkpoint object;
checkpoint roots retain its bodies and recovery hydrates that same immutable object.
`ResourceReference` carries domain, exact view, relative path, canonical identity and actual version.
The owner-supplied domain ID must distinguish the original workspace/user/package domain. Resource IDs
remain stable across revisions of the same canonical skill, while descriptor versions identify exact bytes.

`resourceSections` renders original resource sections before the existing personalization/Transform owners.
A nonempty SYSTEM replaces the supplied runtime preamble; an explicitly empty selected SYSTEM keeps its
selection/provenance and uses that preamble, without falling back to the user's SYSTEM. The consumer keeps
runtime identity/capabilities outside any replaceable user section as needed. Skill metadata requires the
consumer's actual registered read-tool name; this module does not invent a `read` tool or add a whitelist.

## Admission and existing owners

- Project settings come from `cwd/.varin/settings.json` in the admitted source reader. Resource options
  live in its `resources` object; files live in `cwd/.varin/resources`. `projectTrusted` comes from native
  `VARIN_DATA_DIR/project-trust.json`. Project settings/SYSTEM/APPEND/skills require that decision;
  directory context files follow the already-admitted source.
  Each skill records its actual selection’s `requiresProjectTrust` dependency, including project package
  overrides. Revoking project trust does not disable independent user skills or directory instructions.
- Global resource options come from `VARIN_DATA_DIR/agent-settings.json`, sharing model/harness settings
  validation and revision CAS. User resource files have a separate exact `VARIN_DATA_DIR/resources` domain
  and optional `HOME/.agents` domain. Discovery reads only the expected configuration/instruction/skill paths.
  Neither domain becomes a model-controlled arbitrary file or process grant.
- `installedPackages` accepts canonical identity, original source/scope and the already installed asset
  reader supplied by `packages.ts`. Local sources resolve beneath the selected resource directory;
  remote source labels require an explicit `installedPath`. Missing installations remain diagnostics.
  Package resolution uses the exact captured settings, so an edit during preparation cannot pair a new
  configuration with an older directory selection. No network install, cache probing or loader is involved.
  Source-contained project package files must use the source pin. Independent user/package assets need
  their own precise view and publication, not a claim that they belong to the project pin.
- Configured relative paths are resolved against the original user or project resource directory.
  Normalizing `..` is allowed when the result remains in the admitted domain. Absolute, home-relative,
  out-of-domain, or separately mounted paths require an exact `configuredPaths` mapping prepared by the
  existing source/resource admission owner. A fixed project dependency uses an immutable capsule unless
  explicitly admitted as an independent user resource. Configuration text alone is not permission.
- External ancestors are ordered, immutable capsules prepared with source selection. They contain just
  the necessary context candidates/content/absence facts; there is no live ancestor traversal. Existing
  worktree admission can supply canonical context identities shadowed by the selected linked worktree.
  Ancestors marked `includeSkills` contribute their captured `.agents/skills` after source-local skill
  roots, inner-to-outer; admission marks only ancestors inside the original nearest-Git-root skill chain.
- The resource editor uses Documents' private Host resource-access port for the configured data
  directory and `HOME/.agents`. This remains available when a Docker deployment places its workspace
  root elsewhere. Catalog selection, project trust and revision CAS still gate edits. These domains
  do not expand the public Documents/Files boundary or grant access merely through a registered ID.
- `AgentSettingsService` remains the only native settings writer. Resource files use their existing
  admitted document/file owner. Saving an asset does not mutate an existing snapshot. The consumer prepares and conditionally publishes a new candidate.

## Reader adapters and consistency

`source-reader.ts` supplies adapters for existing owners:

Original file bytes use the shared Rust text codec, including GBK/GB2312 and UTF-16;
captured resource bodies are Unicode, not byte buffers implicitly decoded as UTF-8. Readers keep
the selected source's per-file encoding policy. Fixed readers use the exact branch/revision policy
projection, including committed conversions; a same-pin symlink scope extension also projects its
target's policy. Captured editor drafts use their own serialized format. Source validation compares
original raw revisions/hashes, never a UTF-8 hash of decoded text. Parser-visible BOMs are retained.
Protocol and provenance JSON retain their separate UTF-8 wire/storage contract.

- `createPinnedResourceReader`: `WorkingState.readPath/listPaths/readContent` with the caller's original
  pin and capture coverage. It does not acquire or release a pin. Relative file and directory symlinks are
  resolved component by component inside that same pin, including `..` that remains inside the pin.
  Actual cycles are `invalid`; no arbitrary depth limit is added. Absolute/out-of-pin links require an
  independently captured dependency, not later disk access. Canonical identities deduplicate aliases.
- `createCapsuleResourceReader`: exact captured files, directory listings and explicit missing candidates.
  Inputs are copied. An uncaptured path is `unavailable`, not inferred missing.
- `createDocumentResourceReader`: Documents `readSnapshot` plus an admitted directory-listing callback.
  It preserves the actual raw document revision, a supplied capture policy (including Auto), and
  cancellation. It is `capture-only`.
- `createAdmittedDirectoryReader`: read-only local user/installed-package assets at an owner-admitted
  root. It uses the existing canonical path/containment helpers, checks root and file identity, reports
  changes during capture, and is `capture-only`. Known nonregular files are rejected before opening;
  platform nonblocking open plus handle type/identity checks prevents a FIFO replacement from waiting
  for a writer. There is no generic timeout, byte limit, or rejection of valid contained symlinks. It is not a replacement workspace filesystem authority.

Immutable readers may resolve additional nested instructions or skill support files in their exact view.
Capture-only readers may only serve bodies already captured in the candidate; an unknown path returns
`unavailable` with the required path. A new candidate can capture just `instructionDirectories` and/or
`supportingFiles` needed by the pending operation. This module never triggers a refresh or rewrites the
current binding on its own. The consumer owns the corresponding generation/CAS boundary.

Skill support paths are relative to the selected bundle. Local `file:` identities use the existing
platform-aware containment helper (Windows drive/UNC and POSIX); immutable resource identities keep their
own slash-based namespace. Both lexical traversal and canonical symlink escape are rejected; visibility of a global skill does not authorize reading another bundle or user secrets.
Explicitly captured external references need their own admitted resource scope, not a body-declared grant.
Scripts can be read as resources, but this module never executes them or changes execution permission.

Results distinguish `ready` (including an empty string), `missing`, `invalid`, `denied`, `unavailable`,
`stale`, and `cancelled`. Every failure carries domain/view/path and a content-free reason. Missing required
configuration means the existing default; malformed configuration fails preparation. Malformed skills,
filter exclusions, collisions and unavailable optional resource roots remain observable diagnostics.
A higher-priority inaccessible SYSTEM does not silently select a lower-priority one. A non-file context
alias is diagnosed and skipped, matching first-file selection; binary or invalid text is not treated as missing.
No operation logs prompt or file bodies.

## Original capture coverage is necessary

The existing source paths have different inventory contracts:

1. Native main `kernel/thread-sources.ts` uses `captureStableSourceBaseline` with the existing exhaustive
   directory inventory, including hidden and ignored paths except traversed `.git`/`.varin` directories.
   Resource observation participates in the same Documents coordination and capture validation.
2. Isolated child preparation retains the existing Git inventory/content contract. Git untracked
   inventory excludes ignored files, so the original capture explicitly adds selected resource
   dependencies and their absence/coverage facts. It does not scan the whole ignored project tree.
   Non-Git capture remains exhaustive. Fixed inheritance copies the original resource provenance.

A missing tree entry cannot prove the original ignored file was absent. The pinned reader therefore
requires coverage from original source preparation: `complete` for a proven exhaustive scope, or
`selected` with explicitly observed paths (including absence observations) and fully captured subtrees.
Present entries can be read without a blanket coverage claim. Missing uncovered paths and incomplete
directory listings return `unavailable` / dependency-not-captured. Coverage does not authorize a broader
scope and is not a second source catalog.

Integration must prepare the relevant config/context candidates and selected skill/ignore/manifest paths
inside the original capture transaction, preserving its existing inventory/content verification and
Documents coordination. Store coverage alongside that source receipt. Do not collect the whole ignored
ancestor/project tree just to include one resource domain. Do not reconstruct old coverage by reading
later live files, and do not label every old pin complete or reject every old pin uniformly.

## Selection and parsing

- Context aliases: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`; first file
  per directory. User context comes first, then admitted outer-to-inner ancestors/source directories.
  An on-demand target chain excludes sibling directories.
- SYSTEM and APPEND each choose trusted project over user independently; append files are not summed.
- Skills: project explicit paths, project auto discovery, user explicit paths, user auto discovery, packages.
  Existing array order is preserved. Project `.varin/resources` precedes `.agents` from cwd toward its admitted nearest
  Git/root boundary; user resource-dir skills precede `HOME/.agents/skills`. The caller supplies that boundary
  from existing source/Git admission; this owner never walks out of its source to discover one.
- Canonical resource duplicates and same-name losers retain diagnostics. Project package identity wins;
  `autoload:false` is an ordered delta over an existing user package. Package `skills: []` disables that
  resource type. A package manifest's `varin.skills: []` remains empty for a source-only structured
  settings entry too; only an actual skills filter or autoload delta can override that manifest default.
  Plain filters, `!glob`, `+exact-path`, and `-exact-path` apply include, exclude, exact include, exact exclude in that order.
  Local wildcard filter entries do not create source paths. Explicit package manifest globs expand only
  visible paths beneath their admitted prefix. Unconfigured packages are not scanned.
- A root SKILL.md stops recursion. Native roots admit direct markdown files; `.agents` discovery preserves
  its separate nested-markdown behavior. Existing `.gitignore`, `.ignore`, `.fdignore` rules are read from
  the same view. Dot directories and node_modules are skipped by ordinary skill discovery.
- YAML parsing preserves the locked BOM/CRLF and delimiter semantics. Missing/empty descriptions are not
  catalog entries. Name fallback and name/description format/length issues remain warnings when loadable,
  not new hard limits. Unknown frontmatter is ignored by metadata; `allowed-tools` grants nothing.
  `disable-model-invocation` hides automatic metadata only, so explicit user invocation can still select it.

## Native consumer and package boundary

`thread-resource-scope.ts` binds actual user/project settings, trust and installed assets, plus the source
receipt's capsules and coverage. Main and child paths use their own admitted identity. Installed package
identity comes from native explicit package admission, without loader execution or install.
A source-contained dependency uses its pin; external ancestors/configured assets use captured capsules.

The runtime's `ContextResources` holds the original source provenance and full snapshot. Input source
replacement publishes its prepared context with the new input/Run in one transaction. Personalization
refresh retains these resources; resource refresh is a separate CAS preserving summary, memory snapshot,
profile identity and composition. Fork and compaction retain original resource bytes. A fork does not
inherit file/process execution grants merely because its context references the source's resources.

`resource_read` is an ordinary read-only Result tool in the existing registry. The private bridge carries
actual Run, ModelStep/policy origin, call and checkpoint identity, which Catalog verifies before worker
hydration. The model supplies a selected resource ID or relative target, optionally selecting a retained
explicit-input activation. That selector is checked against the actual invocation and original input;
it is not permission to name an arbitrary checkpoint. Captured reads need no
source reopening. An uncaptured immutable dependency reopens its original branch/revision with a narrow
`storage.read` grant and temporary owner pin; it has no physical file root, recovery or write capability.
Cancellation and epoch checks fence the original call. A missing original reader remains unavailable;
later live content cannot substitute for the frozen body. Capture-only additions require explicit refresh.

The authenticated resource refresh route and Thread UI use the displayed checkpoint revision. Stale,
failed or cancelled preparation leaves the old generation visible. Bot knowledge/persona remains
separate from ordinary memory.

`resources.packages` accepts a local directory string or `{ source, installedPath?, skills?, autoload? }`.
For example, `{ "source": "npm:@example/skills@1", "installedPath": "packages/example" }` consumes an
already installed native directory. npm identities omit the version; `git:https://...#ref` identities
omit the revision. Package manifests use `package.json` → `varin.skills`; a Pi-only manifest is invalid.
Plain native directories may use the conventional `skills` folder without a manifest.

Varin's `ExtensionPackageManager` remains the executable extension installation owner. Its extension
manifest/lifecycle and this read-only skill-resource manifest are separate contracts. Pi-specific
`packages.install/update/remove` and plugin loaders are not exposed here; replacing them with a second
network installer would introduce another authority. The resource owner never guesses Pi installation paths.

### Explicit input material

`activation.ts` retains leading `/skill:` syntax and the first ASCII-space delimiter for manual
commands. Structured composer selections additionally bind exact resource IDs and captured versions to
UTF-16 ranges anywhere in the raw input. `thread-skill-input.ts` resolves both paths from the full
published snapshot, rechecks the existing resource admission and parses captured SKILL.md content
without reopening live files or settings. Explicit selections follow text order, and repeated references
to the same effective resource load once. Identity is never inferred from a display name; stale versions,
ambiguous manual names, invalid ranges, missing resources and denied admission remain distinct failures.

`ThreadResourcesAPI.skills` obtains content-free candidate metadata from the actual branch checkpoint
or an explicitly admitted pending source through the same context owner. `draftSkills` discovers global or explicit pending-source resources before a Thread exists, using the
same resource readers, project trust and precedence as execution. Pending selections retain the exact
source owner, workspace, domain, path and content version; acceptance maps these to the captured
descriptor and rejects drift. Managed discovery runs on the original target with read permission. It does not
pretend that a navigation project is a prepared execution source. Project/managed-source discovery
requires that actual source; a management-list ID is not a substitutable selector.

The Thread adapter passes preparation alongside unchanged selection ranges and text/media. Catalog
binds it to the same initial/source-replacement checkpoint or compares the existing checkpoint ID, and
stores all skill bodies with the original input. Submit/enqueue retries reuse the original matching
receipt before resource preparation. Object references additionally retain raw text and material IDs in
a typed `referenceIntent`; receipt lookup does not re-resolve current family membership, source locators
or material bodies, and an accepted retry returns the original frozen context. A user child continuation freezes its selected resources at durable
acceptance; delayed source preparation cannot select a newer version. Previously accepted continuations
without frozen input retain their original compatibility path. Queue edits share the existing revision
CAS: unchanged text and selectors preserve old material, changed selections prepare new material, and
ordinary replacement text clears it. Failure changes neither media nor material.

Names containing ASCII spaces can be selected structurally even though the legacy command syntax
cannot represent them. Hidden/model-invocation-disabled skills remain explicitly selectable, subject to
the same resource admission. No selection grants tool, file or process access.

Typed activations travel with the real compiled ModelStep/policy history. Compaction retains small source
references; fork/recovery uses actual inherited input ancestry. A support-file read selecting an activation
uses that original snapshot/version even after refresh. Omitting the selector reads the invocation's
current catalog; it does not infer which historical input the caller means. An accepted body is immutable input history;
later trust revocation does not rewrite it, but every new resource read still checks current trust.

There is no watcher, second persistence/CAS database, settings writer or package installer in this directory.
Native Host IPC acceptance remains separate; focused tests are not a substitute for it.

## Focused verification

From the repository with its provisioned Node/Bun environment:

```sh
bun run --cwd packages/web test application-host/lib/agent-resources/authority.test.ts
./node_modules/.bin/eslint packages/web/application-host/lib/agent-resources/*.ts --config eslint.config.js
./node_modules/.bin/tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node --esModuleInterop \
  packages/web/application-host/lib/agent-resources/{source-reader,configuration,formats,authority,render,authority.test}.ts
```

The behavior suite uses real temporary asset trees and the existing WorkingState test store/pin adapter.
It covers selection, progressive metadata, frozen body reuse, source-relative nested scopes, YAML/ignore
and package rules, untrusted config exclusion, canonical bundle containment, same-pin relative links,
cancellation independence, serializable snapshots and missing capture coverage. Its pinned fixture is
not a real Rust IPC run, and no Host-wide or paid-model validation is implied.

Model-visible skill discovery includes the resource read entry, name, description and origin. Version
hashes remain with the captured directory and explicit activation owner; they are not extra model inputs.
Ordinary reads use the frozen current directory, and historical activations retain their original version.
