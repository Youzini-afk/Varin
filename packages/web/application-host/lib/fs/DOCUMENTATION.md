# FS Module Documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, directory listing, reveal, foreground command execution, and job observations. Background execution requests are rejected.

## Entrypoints and structure
- `packages/web/application-host/lib/fs/routes.ts`: route registration and runtime-owned state for `/api/fs/*` endpoints.
- `packages/web/application-host/lib/fs/search.ts`: fuzzy filesystem search runtime used by workspace search and other non-FS routes (for example project icon discovery).

## Public exports
- `registerFsRoutes(app, dependencies)` from `routes.ts`
  - Registers all filesystem routes:
    - `GET /api/fs/home`
    - `POST /api/fs/mkdir`
    - `GET /api/fs/read`
    - `GET /api/fs/raw`
    - `GET /api/fs/serve/:path(*)`
    - `POST /api/fs/write`
    - `POST /api/fs/delete`
    - `POST /api/fs/rename`
    - `POST /api/fs/reveal`
    - `POST /api/fs/exec`
    - `GET /api/fs/exec/:jobId`
    - `GET /api/fs/list`
  - Owns exec job queue state (`execJobs`) and lifecycle/TTL pruning.
  - Enforces workspace boundary checks with active project + worktree fallback support.
- `createFsSearchRuntime({ compute, path? })` from `search.ts`
  - Returns `{ searchFilesystemFiles(rootPath, options), isSearchableFile(...) }`.
  - Native `compute.directory` owns recursive enumeration, physical traversal and Git-visible membership. The adapter only ranks fuzzy matches and preserves enumeration completeness.
  - Hidden-file and gitignore options retain their original native meaning. An explicit caller limit reports incomplete coverage when results were truncated; omitted limits do not introduce a separate cap.
  - The managed ResourceFiles owner invokes this same runtime after admitting its Documents view. Logical adopted selections resolve through the original native workspace receipt, not a coordinator filesystem path.

## Composition contract with `../../index.ts`
- `../../index.ts` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `../../index.ts` no longer owns FS route handlers or FS exec job state.

File-name search for the workbench lives at `GET /api/find/file` in `packages/web/application-host/lib/search/`. Content search is `POST /api/workspace/search/content`. Both stay on the application host.

## Notes for contributors
- Keep filesystem policy (workspace root checks, error mapping, exec timeout behavior) inside this module, not in the composition root.
- If adding new `/api/fs/*` endpoints, add them in `routes.ts` and extend this document.

Managed file-name and content searches use the existing ResourceFiles request transport. `filename-search` returns root-relative file paths and explicit enumeration completeness; `content-search` preserves the native Documents resource identity, revisions, line/column, context and incomplete/error/cancellation states. Target filesystem-read authority and physical allowed-directory admission apply before resolving an adopted view. Search disconnects propagate to the original compute cancellation signal; file mutations retain their separate effect lifecycle.

Read-only remote assets use ResourceFiles `asset()` after the same Documents/native-view admission. Raw images and PDF/HTML assets are streamed, not embedded in a base64 JSON response. Local and remote Office reads/previews share `office/filesystem-reader.ts`, preserving package revisions and the original renderer and cancellation signal. A fixed GET-only asset URL carries an ephemeral existing URL-auth credential and the frozen location prefix so relative HTML resources remain on that same owner; neither credential nor URL is persisted as source identity. Asset responses disallow caching and referrer propagation. Native Documents registration exposes a trusted `authorizationRoot` from its original physical source for paired-host permission checks, distinct from its mounted read view.
