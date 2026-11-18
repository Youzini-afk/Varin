# Projects module

Owns per-project Host configuration (scheduled/loop tasks and per-project text-encoding rules), deterministic path-based project IDs, and coordinated remote project management across paired Hosts. See [docs/resources.md](../../../../../docs/resources.md) and [docs/workbench.md](../../../../../docs/workbench.md).

## Key files

| File | Responsibility |
| --- | --- |
| [`project-config.ts`](project-config.ts) | Per-project config store (`scheduledTasks` CRUD, loop-file task reconciliation, and persisted `textEncoding` rules/revisions) |
| [`project-id.ts`](project-id.ts) | `createProjectIdFromPath`: deterministic `path_<base64url>` ID from normalized POSIX-slash path |
| [`text-encoding.ts`](text-encoding.ts) | Project-relative & per-file text-encoding rule parsing, namespace projection, and branch-isolated choice IDs |
| [`project-management-routes.ts`](project-management-routes.ts) | Coordinator `POST /api/projects/:projectId/management` route forwarding commands for managed remote projects |
| [`managed-project-management.ts`](managed-project-management.ts) | Target-Host adapter executing Git, GitHub, worktree, resource, trust, and native-workspace commands over existing local owners |

## Ownership and invariants

- **Not a second project registry**: Project list registration lives in Settings; `project-config.ts` stores per-project auxiliary state (scheduled tasks, loop reconciliation, text encodings), and `managed-project-management.ts` adapts commands onto the target Host's existing Documents, Git/GitHub, Resources, Trust, and `NativeWorkspaceOwner` services.
- **Text-encoding namespaces**: `text-encoding.ts` projects rules relative to the canonical project root so exact file rules beat directory rules and materialized/isolated branches (`sourceTextEncodingChoiceId`) cannot mutate the live project's encoding choices. Only explicit user choices advance `choiceRevisions`; receipt reconciliation does not.
- **Source fencing & adoption intent**: `POST /api/projects/:projectId/management` rejects drift if `expectedSource` differs from the registered project source. Before enabling a remote versioned workspace, the coordinator requests a deterministic `workspace-plan` and persists that adoption intent first so retries after either Host restarts join the original Storage operation.
- **Mutation observation & permissions**: Read-only management actions forward HTTP abort signals, while mutations do not cancel/replay on disconnect. Target execution enforces paired capabilities (`filesystem:read`, `filesystem:write`, `terminal:use`, `process:control`), Documents workspace admission, and `allowedDirectories` (including primary Git worktree roots and registered worktree verification). Remote callers cannot open or alter local device backend security settings (`backend-settings`).
