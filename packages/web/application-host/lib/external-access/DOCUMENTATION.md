# External Access module

Authenticated automation, rescue, and remote-client HTTP surface (`/api/external/*`) exposing scoped root discovery, filesystem CRUD, shell command execution, and client-auth audit logs. See [docs/security.md](../../../../../docs/security.md) and [ui-auth/DOCUMENTATION.md](../ui-auth/DOCUMENTATION.md).

## Key files

| File | Responsibility |
| --- | --- |
| [`routes.ts`](routes.ts) | `createExternalAccessRootRuntime` and `registerExternalAccessRoutes` for all `/api/external/*` endpoints |

## Routes and required capabilities

- `GET /api/external/me`, `GET /api/external/capabilities`: authenticated caller identity and advertised capability/route list (`external-access.v1`, `external-roots.v1`, `external-fs.v1`, `external-command.v1`, `external-audit.v1`).
- `GET /api/external/status`, `GET /api/external/audit`: runtime info and remote-client audit events (`instance:read`).
- `GET /api/external/roots`, `GET /api/external/fs/list`, `GET /api/external/fs/read`: named-root listing and file reads (`filesystem:read`).
- `PUT /api/external/fs/write`, `POST /api/external/fs/folder`: file writes with optional `expectedMtimeMs` conflict check (`409`) and folder creation (`filesystem:write`).
- `DELETE /api/external/fs/entry`: entry deletion (`filesystem:delete`; refuses deleting a root directly and requires `recursive=true` for directories).
- `POST /api/external/command`: bounded shell command execution under a resolved root (`terminal:use`).

## Ownership and invariants

- **Authorization**: UI sessions and full-control client profiles (`full-control`, `external-agent`, `rescue`) satisfy capability checks; restricted client tokens must explicitly carry the capability (or `<domain>:*` / `*` / `admin`).
- **Named roots & path containment**: Requests address a root ID (`workspace`, `deployment`, `server-package`, `process-cwd`, `data`, `logs`, or client-scoped `client-N`) plus a relative path (absolute paths are rejected). Ancestor `realpath` checks prevent symlink escapes outside the resolved root.
- **Documents coordination**: Mutations targeting the `workspace` root route through `documents.runMutationForScope` (`exact` for file writes, `subtree` for folder/delete, `process` for commands) so editor buffers and file leases stay coherent.
- **Resource bounds**: Hard caps protect the Host — 10 MiB max read, 5,000 list entries (depth ≤ 6), 12 KB max command string, 2 MiB stdout/stderr capture, and 120s default / 10m max command timeout.
