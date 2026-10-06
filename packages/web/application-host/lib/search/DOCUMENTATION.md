# Workspace search

Host-owned search policy and presentation over the Rust kernel's admitted file-compute boundary. The
renderer never walks the workspace, and the Host no longer launches a ripgrep child or keeps a second
recursive scanner for production search.

## Entrypoints

- `content.ts`: `createWorkspaceContentSearch({ documents, compute })` — cancellable native content
  search over a Host-admitted live root, with optional Registry-owned fixed draft overlays.
- `routes.ts`: `registerWorkspaceSearchRoutes(app, deps)` — authenticated search routes.

## Routes

- `GET /api/find/file` — cancellable relative file-name hits for `FilesAPI.search`. Callers may request a result count; omitting it does not silently truncate the search. Failures are HTTP errors, not an empty array.
- `POST /api/workspace/search/content` — discriminated content search:
  - `ready` with hits
  - `empty` when the query is valid and matched nothing
  - `cancelled` when the client disconnects or aborts
  - `failure` with a message when the workspace or native compute authority is unavailable

Web clients request `application/x-ndjson`: bounded kernel record batches are forwarded as they arrive,
HTTP backpressure participates in the compute cursor drain, and a terminal result frame closes the
search. JSON callers and Host capabilities retain the complete-result form. A result count is applied
only when the caller explicitly requests one. Scope, requested paths, draft tombstones, and result
limits are admitted before candidate matching; every hit carries the revision of the bytes that were
actually searched. Live-source drift is partial/failure evidence, never a fabricated immutable view.

Content search never maps compute/workspace failure to zero results. File bodies are not logged.
Electron reuses this Web host. File-name search uses the same native inventory boundary and keeps fuzzy
ranking/presentation in TypeScript rather than maintaining another filesystem traversal authority.

## Capability

Host extensions call `workspace.search` / `searchContent`. Isolated renderers do not spawn search tools.
