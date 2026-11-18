# Workspace module

Owns local workspace configuration, path-safety/scope enforcement, file browsing/uploads/archives/downloads, local Git routes, native versioned-workspace lifecycle routes, and resource-file transfer adapters. Production text/disk writes coordinate with Documents and Rust file-resource owners. See [docs/workbench.md](../../../../../docs/workbench.md) and [docs/resources.md](../../../../../docs/resources.md).

## Key files

| File(s) | Responsibility |
| --- | --- |
| [`workspace-config.ts`](workspace-config.ts) | `VARIN_WORKSPACE_*` env parsing (default root, lockdown, trash, read/upload/download/archive size & count limits) |
| [`path-safety.ts`](path-safety.ts), [`path-scope.ts`](path-scope.ts), [`resource-access.ts`](resource-access.ts) | Canonical path identity, symlink-safe containment, root-restriction checks, and paired-client `allowedDirectories` enforcement |
| [`filesystem.ts`](filesystem.ts), [`workspace-routes.ts`](workspace-routes.ts) | Authenticated `/api/workspace/*` browsing, folder/file CRUD, move/delete, upload, archive, download, project open, and Git routes |
| [`archive.ts`](archive.ts), [`download.ts`](download.ts), [`git.ts`](git.ts), [`reflink.ts`](reflink.ts) | Safe archive preview/extraction, streaming file/directory downloads, Git command helpers, and copy-on-write reflink helpers |
| [`native-workspace-routes.ts`](native-workspace-routes.ts) | `POST /api/projects/:projectId/workspace/:action` routes delegating to `NativeWorkspaceOwner` |
| [`resource-files.ts`](resource-files.ts), [`resource-file-routes.ts`](resource-file-routes.ts), [`asset-response.ts`](asset-response.ts) | `/api/resource-files/*` and `/api/resource-office` local/managed file transfers and safe file-content response forwarding |

## Ownership and invariants

- **Root & lockdown policy**: `VARIN_WORKSPACE_ROOT` overrides the default root (desktop runtime defaults to user home directory on fresh installs). When `lockdown` is enabled or a paired client restricts `allowedDirectories`, [`resource-access.ts`](resource-access.ts) and [`path-safety.ts`](path-safety.ts) enforce canonical containment before any read or write.
- **No silent error masking**: `reflink.ts` treats missing sources (`ENOENT`) and permission failures (`EACCES`/`EPERM`) as real errors rather than unsupported-filesystem fallbacks.
- **Safe asset forwarding**: `asset-response.ts` forwards only safe file-content headers across resource-owner boundaries—never cookies or redirects.
- **Documents & Rust storage coordination**: Text editing remains with [`../documents/DOCUMENTATION.md`](../documents/DOCUMENTATION.md) (`DocumentsAPI`); workspace mutations coordinate through Documents scopes and Rust file-resource owners so editor buffers, recovery journals, and versioned workspaces stay consistent.
- **Native versioned workspaces**: `native-workspace-routes.ts` exposes inspect/enable/disable/backend controls over [`../kernel/native-workspaces.ts`](../kernel/native-workspaces.ts) without creating a second mount or storage owner.
