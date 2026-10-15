# Document Registry

Per-document editing state for Varin workspace text files. High-frequency buffers live in this
external registry, not in Zustand or Local Storage.

- `registry.ts` — load/save/watch, dirty/conflict, in-flight save, recovery journals, Agent/disk source hints;
  concurrent first-open calls share one Host read
- `documentInstanceId` is internal and survives move/rename within one registry generation; editor engines
  use it for stable model identity without publishing workspace paths
- `applyEdits` accepts one captured local revision plus non-overlapping offset edits, advances the local
  revision once, and returns typed stale/invalid/unsupported results
- `prepareWorkspaceEdit` preserves the ordered text/create/rename/delete sequence. Pure text plans
  validate every range and intermediate document version without publishing buffers. Mixed plans
  are simulated by Host Documents; preparation neither changes files nor saves drafts. Review shows
  destructive draft effects and change annotations.
- Pure text apply revalidates and installs every buffer before notifications. Mixed apply uses the
  original Host operation, affected-path barrier, file leases and durable recovery record. Text stays
  in Registry buffers, including text after create; it is not an implicit save. Resource moves keep
  document instances, subscriptions, tabs, Monaco models and language identities aligned.
- Connected affected surfaces contribute read-only preview snapshots. Execution binds each actual
  registration, instance, base and local version. Divergent drafts at one path have no shared text
  version and are reported as conflicts; unrelated windows/resources are not part of the edit.
- One async undo restores the original batch conditionally. Later edits are retained and uncertain
  steps appear in Recovery with per-resource state and original draft content. A lost response reads
  the original operation, never repeats its effects. Reopened records cannot receive old dispatches.
- A code action retains its original language-document owner through its edit and accompanying
  workspace command. Renamed documents use their stable instance's current path; deleted documents
  do not pretend to have a live language version. Original provider/generation checks remain intact.
- Agent patch review uses that same transaction path. A clean accepted patch becomes a dirty editor
  buffer for review and explicit save; dirty, conflicted, saving, missing, or stale documents are
  rejected rather than written directly to disk.
- Three-way conflict stores ancestor, buffer, and disk candidate; writes still use expected revision
- `session.ts` — one registry per bound `DocumentsAPI`
- `hooks.ts` — per-document React subscriptions
- `path.ts` — workspace-relative resource IDs
- `workspace-text.ts` — non-editor text read/write through DocumentsAPI

Files UI still owns tree and Agent tab navigation. Split groups, preview/pinned tabs, and per-view
cursor restore live in the Editor Workbench Kernel. Document records survive Profile/Settings
remounts until application-host endpoint switch. `FilesAPI` and `WorkspaceAPI` no longer expose
text read/write; editors and helpers use DocumentsAPI only.
