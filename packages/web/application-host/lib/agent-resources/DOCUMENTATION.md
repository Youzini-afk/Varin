# Agent instruction and skill resources

Read-only interpreter for admitted instruction, configuration, and skill assets. It is **not** a settings writer, trust store, package installer, file authority, or execution runtime. Entry point: `createAgentResourceAuthority()` in [`authority.ts`](authority.ts).

## Entrypoints and consumers

| File(s) | Responsibility |
| --- | --- |
| [`authority.ts`](authority.ts) | `prepare(admittedScope, signal)` and `read({ snapshot, readers }, request, signal)` |
| [`source-reader.ts`](source-reader.ts) | Pinned, capsule, document, and admitted-directory read-only adapters (using Rust text codec) |
| [`configuration.ts`](configuration.ts), [`formats.ts`](formats.ts), [`packages.ts`](packages.ts) | Settings/filter evaluation, YAML/frontmatter parsing, and installed skill-package resolution |
| [`render.ts`](render.ts), [`activation.ts`](activation.ts) | Prompt section rendering (`SYSTEM`/`APPEND`/skills) and explicit `/skill:` / structured selection parsing |
| [`management.ts`](management.ts), [`management-routes.ts`](management-routes.ts), [`project-management.ts`](project-management.ts) | Authenticated resource editor/preview routes and managed remote project forwarding |

**Native consumers**: [`../kernel/thread-resource-scope.ts`](../kernel/thread-resource-scope.ts), [`../kernel/thread-context.ts`](../kernel/thread-context.ts), [`../kernel/resource-owner.ts`](../kernel/resource-owner.ts) (private `resource_read` bridge), [`../kernel/thread-skill-input.ts`](../kernel/thread-skill-input.ts) (explicit input activation), and [`../memory/prompt-tool-catalog.ts`](../memory/prompt-tool-catalog.ts) (settings prompt/tool preview; never executes tools or connects MCP servers).

## Two operations and snapshot contract

- **`prepare(admittedScope, signal)`**: Produces frozen JSON `PreparedAgentResources` (selected `SYSTEM`/`APPEND` refs, instruction chains, skill metadata, `capturedFiles` including `SKILL.md` bytes, observed dependencies, and diagnostics). Publishes nothing; native consumers store it in a ContentStore-backed `ContextCheckpoint`.
- **`read({ snapshot, readers }, request, signal)`**: Serves `skill(resourceId)`, `skill-resource(resourceId, relativePath)`, and `instruction-scope(targetPath, targetType?)` using caller-supplied authorized readers (never model-supplied selectors). Skill reads reuse `capturedFiles` bytes rather than rereading live disk.
- **`resourceSections` (`render.ts`)**: Renders resource sections before personalization/transform owners. A nonempty `SYSTEM` replaces the runtime preamble; an explicitly empty selected `SYSTEM` keeps its selection and uses the preamble without falling back to user `SYSTEM`. Skill metadata names only the consumer's actual registered read tool (`resource_read`) and omits internal version hashes.
- **Status taxonomy**: Distinguishes `ready` (including empty string), `missing`, `invalid`, `denied`, `unavailable`, `stale`, and `cancelled` with content-free diagnostics (never logs prompt or file bodies). Missing config uses defaults; malformed config fails preparation; inaccessible higher-priority `SYSTEM` never falls back to a lower-priority one.

## Admission, roots and package boundary

- **Roots & trust**:
  - Project settings (`<cwd>/.varin/settings.json` -> `resources`) and files (`<cwd>/.varin/resources`, project `SYSTEM`/`APPEND`/skills) require `projectTrusted` from native `VARIN_DATA_DIR/project-trust.json`. Each skill records `requiresProjectTrust`; revoking project trust leaves independent user skills and admitted directory context files intact.
  - Global options come from `VARIN_DATA_DIR/agent-settings.json` (`AgentSettingsService` is the sole settings writer). User roots are `VARIN_DATA_DIR/resources` and optional `HOME/.agents`.
  - Relative configured paths resolve inside their admitted domain; absolute, home-relative, or out-of-domain paths require explicit `configuredPaths` mappings from the admission owner.
  - External ancestors are immutable capsules prepared at source selection (no live ancestor traversal; `includeSkills` marks only ancestors inside the admitted nearest-Git-root chain).
- **Installed skill packages (`packages.ts`)**: `resources.packages` accepts local directory paths or `{ source, installedPath?, skills?, autoload? }` pointing at already-installed directories (`package.json` -> `varin.skills`, or conventional `skills/` folder). Never installs packages or executes code — executable extension lifecycle belongs to `ExtensionPackageManager`.

## Readers, encoding and capture coverage

All readers decode bytes via the shared Rust text codec (preserving GBK/UTF-16/BOM and per-file encoding policies) and compare raw revisions/hashes rather than UTF-8 hashes of decoded text:

- `createPinnedResourceReader`: reads `WorkingState` under the caller's existing pin; resolves contained relative symlinks (cycles are `invalid`; out-of-pin links require an independently captured dependency).
- `createCapsuleResourceReader`: serves exact captured files/listings/absence facts; uncaptured paths return `unavailable`.
- `createDocumentResourceReader`: capture-only adapter over Documents `readSnapshot` + admitted directory listing.
- `createAdmittedDirectoryReader`: capture-only read-only local reader for user/package roots; rejects non-regular files (nonblocking open + handle identity checks against FIFO races) and lexical/symlink escapes.

**Capture coverage invariant**:
- Main sources (`kernel/thread-sources.ts`) capture `complete` exhaustive baselines (excluding traversed `.git`/`.varin`).
- Isolated Git child preparation uses `selected` coverage, explicitly recording observed resource dependencies and absence facts without scanning ignored trees. Missing uncovered paths return `unavailable` rather than inferring absence; fixed provenance is never repaired by reading later live disk.

## Selection, parsing and explicit activation

- **Context aliases**: First matching file per directory from `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` (user first, then outer-to-inner ancestors/source; on-demand chains exclude siblings).
- **`SYSTEM` / `APPEND`**: Trusted project beats user independently for each (append files are not summed).
- **Skills precedence**: Project explicit -> project auto (`.varin/resources`, then `.agents` from cwd to admitted Git root) -> user explicit -> user auto (`VARIN_DATA_DIR/resources`, then `HOME/.agents/skills`) -> packages (`autoload: false` and `skills: []` act as ordered deltas; filters apply plain include -> `!glob` -> `+exact` -> `-exact`). A root `SKILL.md` stops recursion; `.gitignore`/`.ignore`/`.fdignore` apply; dot dirs and `node_modules` are skipped.
- **YAML frontmatter**: Missing/empty `description` excludes from catalog; `allowed-tools` grants nothing; `disable-model-invocation` hides from automatic metadata while remaining explicitly selectable.
- **Explicit input activation (`activation.ts`, `kernel/thread-skill-input.ts`)**: Supports leading `/skill:` syntax and structured composer selections (`resourceId` + captured version + UTF-16 ranges, including names with spaces). `draftSkills` discovers global or pending-source skills before Thread creation and rejects drift at acceptance. Accepted skill bodies persist immutably with the input (reused on retry/compaction/fork); `resource_read` checks current trust and invocation ancestry on every read and reopens uncaptured immutable branches with a narrow read-only grant.

## Registered remote project management

Resource editor/management routes (`management-routes.ts`, `project-management.ts`) resolve the registered project source before path canonicalization and fence delayed reads/writes with `expectedSource`. Managed requests forward to the target Host's resource editor using its physical Documents registration, trust service, and CAS (enforcing paired root restrictions). Saves affect the next live capture, not already-frozen execution snapshots.

## Verification

Run `bun run --cwd packages/web test application-host/lib/agent-resources/authority.test.ts` (covers selection, frozen bodies, symlinks, coverage, YAML/ignore rules, and untrusted exclusion). See [development guide](../../../../../docs/development.md).
