# FS Module Documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, directory listing, reveal, and background command execution jobs.

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
- `createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn })` from `search.ts`
  - Returns `{ searchFilesystemFiles(rootPath, options) }`.
  - Supports fuzzy matching, hidden-file handling, and optional gitignore filtering.
  - `respectGitignore` costs **one** `git ls-files -z --cached --others --exclude-standard`
    for the whole walk, not one `git check-ignore` per directory. The catalog scan
    walks an entire workspace, and the per-directory shape cost one process per
    directory — 4363 of them on this repository, where the bare walk is 1.6 s (D-140).
    A file present on disk but absent from that listing is ignored; a directory is
    descended only when some listed path lives under it.
  - Outside a Git work tree the listing fails and nothing is treated as ignored,
    which is the answer the per-directory probe also gave on failure. Three callers
    share this path: the workbench file picker, the settings page language
    distribution (D-120), and the cold catalog scan (D-107).

## Composition contract with `../../index.ts`
- `../../index.ts` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `../../index.ts` no longer owns FS route handlers or FS exec job state.

File-name search for the workbench lives at `GET /api/find/file` in `packages/web/application-host/lib/search/`. Content search is `POST /api/workspace/search/content`. Both stay on the application host.

## Notes for contributors
- Keep filesystem policy (workspace root checks, error mapping, exec timeout behavior) inside this module, not in the composition root.
- If adding new `/api/fs/*` endpoints, add them in `routes.ts` and extend this document.
