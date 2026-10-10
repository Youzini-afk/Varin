# Agent instruction and skill resources

This module owns read-only interpretation of already admitted instruction/configuration/skill assets.
It is not a settings writer, trust store, package installer, file authority, runtime, or generation database.
The entry point is `createAgentResourceAuthority()` in `authority.ts`.

## Current delivery boundary

The native Thread path uses this owner through `kernel/thread-resource-scope.ts`,
`thread-context.ts`, and the private `resource_read` owner. Prepared bytes live in the existing
ContentStore-backed ContextCheckpoint. ModelStep and policy calls retain the exact checkpoint they
selected; a resource refresh publishes by revision without changing an in-flight call.

Explicit `/skill` input activation and convergence of the older Pi resource catalog/commands and editors
remain separate work. This slice does not activate Pi loaders/extensions, resolve/install packages,
invoke a model, or replace the existing settings and trust authorities.

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

- Project settings come from `cwd/.pi/settings.json` in the admitted source reader. `projectTrusted` comes
  from the existing `ProjectTrustStore` decision. Only project settings/SYSTEM/APPEND/skills are gated by
  that decision; directory context files follow the already-admitted source, matching the locked Pi rule.
  Each skill records its actual selection’s `requiresProjectTrust` dependency, including project package
  overrides. Revoking project trust does not disable independent user skills or directory instructions.
- User resources come from an exact admitted agent-directory domain and, separately, an optional
  `HOME/.agents` domain. Discovery reads only the expected configuration/instruction/skill paths.
  Neither domain becomes a model-controlled arbitrary file or process grant.
- `installedPackages` accepts canonical identity, original source/scope and the already installed asset
  reader supplied by the existing package authority. The host can derive these from the read-only
  `PackageAuthorityHost.listPackages` / `DefaultPackageManager.listConfiguredPackages` path. Do not call
  `DefaultPackageManager.resolve`, a loader reload, or an installation method to obtain them.
  Source-contained project package files must use the source pin. Independent user/package assets need
  their own precise view and publication, not a claim that they belong to the project pin.
- Configured relative paths are resolved against the original user agent directory or project `.pi` base.
  Normalizing `..` is allowed when the result remains in the admitted domain. Absolute, home-relative,
  out-of-domain, or separately mounted paths require an exact `configuredPaths` mapping prepared by the
  existing source/resource admission owner. A fixed project dependency uses an immutable capsule unless
  explicitly admitted as an independent user resource. Configuration text alone is not permission.
- External ancestors are ordered, immutable capsules prepared with source selection. They contain just
  the necessary context candidates/content/absence facts; there is no live ancestor traversal. Existing
  worktree admission can supply canonical context identities shadowed by the selected linked worktree.
  Ancestors marked `includeSkills` contribute their captured `.agents/skills` after source-local skill
  roots, inner-to-outer; admission marks only ancestors inside the original nearest-Git-root skill chain.
- Existing settings and `RevisionedTextFileEditor` remain the writers. Saving an asset does not mutate an
  existing snapshot. The consumer prepares and conditionally publishes a new candidate.

## Reader adapters and consistency

`source-reader.ts` supplies adapters for existing owners:

- `createPinnedResourceReader`: `WorkingState.readPath/listPaths/readContent` with the caller's original
  pin and capture coverage. It does not acquire or release a pin. Relative file and directory symlinks are
  resolved component by component inside that same pin, including `..` that remains inside the pin.
  Actual cycles are `invalid`; no arbitrary depth limit is added. Absolute/out-of-pin links require an
  independently captured dependency, not later disk access. Canonical identities deduplicate aliases.
- `createCapsuleResourceReader`: exact captured files, directory listings and explicit missing candidates.
  Inputs are copied. An uncaptured path is `unavailable`, not inferred missing.
- `createDocumentResourceReader`: Documents `readSnapshot` plus an admitted directory-listing callback.
  It preserves the actual document revision and propagates cancellation. It is `capture-only`.
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
alias is diagnosed and skipped, matching first-file selection; malformed UTF-8 is not treated as missing.
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
  Existing array order is preserved. Project `.pi` precedes `.agents` from cwd toward its admitted nearest
  Git/root boundary; user agent-dir skills precede `HOME/.agents/skills`. The caller supplies that boundary
  from existing source/Git admission; this owner never walks out of its source to discover one.
- Canonical resource duplicates and same-name losers retain diagnostics. Project package identity wins;
  `autoload:false` is an ordered delta over an existing user package. Package `skills: []` disables that
  resource type. A package manifest's `pi.skills: []` remains empty for a source-only structured
  settings entry too; only an actual skills filter or autoload delta can override that manifest default.
  Plain filters, `!glob`, `+exact-path`, and `-exact-path` preserve the locked SDK order.
  Local wildcard filter entries do not create source paths. Explicit package manifest globs expand only
  visible paths beneath their admitted prefix. Unconfigured packages are not scanned.
- A root SKILL.md stops recursion. Pi roots admit direct markdown files; `.agents` discovery preserves
  its separate nested-markdown behavior. Existing `.gitignore`, `.ignore`, `.fdignore` rules are read from
  the same view. Dot directories and node_modules are skipped by ordinary skill discovery.
- YAML parsing preserves the locked BOM/CRLF and delimiter semantics. Missing/empty descriptions are not
  catalog entries. Name fallback and name/description format/length issues remain warnings when loadable,
  not new hard limits. Unknown frontmatter is ignored by metadata; `allowed-tools` grants nothing.
  `disable-model-invocation` hides automatic metadata only, so explicit user invocation can still select it.

## Native consumer and remaining convergence

`thread-resource-scope.ts` binds actual user/project settings, trust and installed assets, plus the source
receipt's capsules and coverage. Main and child paths use their own admitted identity. Installed package
identity comes from the read-only Pi package configuration adapter, without loader execution or install.
A source-contained dependency uses its pin; external ancestors/configured assets use captured capsules.

The runtime's `ContextResources` holds the original source provenance and full snapshot. Input source
replacement publishes its prepared context with the new input/Run in one transaction. Personalization
refresh retains these resources; resource refresh is a separate CAS preserving summary, memory snapshot,
profile identity and composition. Fork and compaction retain original resource bytes. A fork does not
inherit file/process execution grants merely because its context references the source's resources.

`resource_read` is an ordinary read-only Result tool in the existing registry. The private bridge carries
actual Run, ModelStep/policy origin, call and checkpoint identity, which Catalog verifies before worker
hydration. The model supplies only a selected resource ID or relative target. Captured reads need no
source reopening. An uncaptured immutable dependency reopens its original branch/revision with a narrow
`storage.read` grant and temporary owner pin; it has no physical file root, recovery or write capability.
Cancellation and epoch checks fence the original call. A missing original reader remains unavailable;
later live content cannot substitute for the frozen body. Capture-only additions require explicit refresh.

The authenticated resource refresh route and Thread UI use the displayed checkpoint revision. Stale,
failed or cancelled preparation leaves the old generation visible. Explicit `/skill:name args` activation,
older Pi catalog/command convergence and full resource editing UI remain to be connected before claiming
one complete product consumer. Bot knowledge/persona remains separate from ordinary memory.

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
