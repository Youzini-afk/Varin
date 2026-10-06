# Varin native recovery journal

Status: built-in kernel provider delivered; Rust system-kernel Stage R complete through D-282.

Last updated: 2026-10-06

## Decision

Varin owns combined conversation and file rollback through the selected versioned
`varin.workspace-recovery` Host service. Pi remains authoritative for its append-only conversation
tree. The official provider is the statically distributed, replaceable
`varin.builtin.recovery` extension; it is not a Pi package or a separately published application
package.

The recovery unit is an affected-file change set. A message checkpoint is not a complete manifest of
the workspace and does not schedule a background archive.

The built-in provider delegates immutable objects, recovery records, conditional file operations and
process-writer gates to the private Rust kernel. Stage R is complete; it has no production TS storage
fallback. The Host coordinates Pi navigation and Documents, whose Registry remains the buffer owner.
Current resource ownership is in [the Rust design](rust-kernel-design.md); implementation and capability
flags are in [the Recovery module](../../packages/web/application-host/lib/recovery/DOCUMENTATION.md).

`pi-workspace-history` and `pi-wtf` are ordinary optional Pi packages. They are neither provisioned nor
consulted by Varin's native rollback path.

## Why the full-workspace transaction model was removed

The first native implementation represented every turn as a complete flat workspace manifest. Even an
incremental turn copied every prior manifest row into a new revision. Establishing the first baseline
read and hashed the entire workspace; restore preparation created another complete safety snapshot and
restore verification captured the workspace again. A data-heavy workspace therefore paid O(total file
count + total bytes) for a no-op message.

Global maintenance, clone/new-workspace fallback, Git inspection, full-manifest planning, staging, and a
multi-step conversation/files saga then placed exceptional recovery concerns on every normal message
rollback. Durable operation records could also grow with the complete workspace.

Mature editors use a narrower unit. The following editor behaviors are historical external evidence,
not current Varin integrations:

- VS Code captures a file baseline when that file is first edited in a request and records file
  operations afterward;
- JetBrains Local History records old content at VFS mutation boundaries and groups those events into
  change sets;
- Zed delegates whole-tree structural sharing to Git and consequently cannot provide the same feature
  outside a repository.

Varin follows the first two patterns and keeps Git out of the authority path.

## Product semantics

### Conversation rollback

Conversation-only rollback branches Pi's native session tree and restores editable user text/images.
It never waits for or modifies workspace history.

### Combined rollback

Returning to a user message removes that message and later entries from the active branch, then reverses
the exact file change sets bound to those entries. Returning to an assistant message keeps that turn and
reverses only later turns.

When all affected paths still equal their recorded after-state and the dirty-state checks pass,
combined rollback executes directly.
The normal UI does not open a restore planner.

The chooser appears only when:

- the user selected **always ask**;
- an affected path was edited again or has an unsaved buffer;
- the turn contains unjournalled external/shell changes.

It offers the relevant decision only: restore the affected paths, return the conversation alone, or
cancel. Affected dirty buffers must currently be saved or discarded before file restore can apply;
confirmation alone does not bypass that check. There is no normal new-workspace mode.

### Redo

Before applying the inverse change set, Varin records the current state of those affected paths. That
small safety set drives operation compensation and explicit undo/redo. No full safety snapshot is
created.

## Capture protocol

The Host negotiates `workspaceMutationJournal` and document-source capabilities with Pi. In Varin's
Host-backed path, same-name `write`/`edit` definitions first try the caller's isolated branch, then
`document.surfaceWrite` for admitted disk or fixed Registry targets. The Host persists mutation intent
and coordinates the corresponding Rust or Registry authority. `apply_patch` uses the same boundary.
An unavailable Host mutation backend is an error, never permission for a parallel Pi-worker disk write.

The generic journal-only Pi path can wrap native execution with before/after observations; it is not
the production Host-backed disk writer. Journal observation failure and mutation-backend failure have
different consequences and must not be described as one fail-open operation.

The first before-image and final after-image are authoritative when one path is written repeatedly in
a turn. A write returning the file to its original state removes its change record. Unsaved surface
writes remain unsaved and require their fixed owner/revision; a disk watcher is not their authority.

## Turn binding and branch selection

Each accepted user entry creates a checkpoint and binding keyed by the broker execution ID. The broker
retains that execution correlation from prompt acceptance through `agent_start`, tool activity, and
`agent_settled`; prompt acknowledgement is not agent completion.

Recovery navigation preparation returns `removedEntryIds` for the current branch. Combined recovery
loads only checkpoints whose user or assistant entry is in that set. Recovery to another non-ancestor
branch is conversation-only until a forward file journal exists for that branch.

## Path state and storage

A path state is one of:

- missing;
- regular file with SHA-256 content object, byte length, and mode;
- directory with mode;
- symbolic link with its raw target and mode;
- explicitly unsupported.

The catalog stores checkpoint metadata, per-path before/after states, turn bindings, and compact recovery
operations. It does not store one row for every workspace path at every turn. Large files are streamed;
there is no arbitrary product file-size cutoff. Cost is paid only when a touched path actually needs a
before/after object.

Storage location is provider capability, not a mandatory built-in mode. The built-in Rust provider shares
WorkingState's kernel root at `<VARIN_DATA_DIR>/kernel/<hostId>`, reports `application-data`, and advertises
`storageManagement: false`; it has no project override or independent transfer because R1 keeps WorkingState,
Recovery, and their object references in one transaction authority.

Replacement providers may advertise `storageManagement` and the v5 application-data, workspace-local,
workspace-adjacent or custom location contract. Their transfer, retention and cleanup remain provider-owned.
The built-in provider advertises neither storage management nor configurable history retention or
workspace-history deletion. Shared kernel size is Host-wide, not reclaimable per-workspace history size.
Object GC still respects all WorkingState, recovery, result and temporary references.

## Restore algorithm

For every affected path, preparation folds chronological turn changes into:

- `target`: the earliest before-state;
- `expected`: the latest after-state.

Preparation hashes only those current paths and reports content or dirty-buffer conflicts. Before either
preparation or apply inspects files, the Host asks every connected document surface to fence the affected
paths, wait for in-flight saves, publish its latest dirty-buffer revision, and acknowledge the barrier.
Apply holds that barrier while it rechecks each path, stores its safety state, atomically replaces the
path, and verifies the target identity. A disconnected or unresponsive surface produces the retryable
`dirty-state-unavailable` result rather than an empty dirty set. The acknowledgement deadline defaults to
one document-watch heartbeat and can be changed with `VARIN_DIRTY_BARRIER_TIMEOUT_MS`.

If a later path fails, or Pi rejects the expected conversation leaf, Varin restores already-applied
paths from the safety set when their current identity still matches the attempted target. A concurrent
external edit is never overwritten by compensation; the operation becomes `needs-attention` with the
exact path. No global workspace maintenance bit survives a crash.

On Host startup, a planned operation stays inert. An interrupted file operation is compensated from its
recorded affected-path safety set before new recovery work is accepted.

The built-in kernel has one OS-held storage-owner lock and Rust file-resource gates; it does not use the
retired TS recovery engine's shared-root sidecar lease. Optional replacement-provider lease contracts do
not make the built-in kernel independently relocatable or safe for a second writer.

## External and shell boundary

A generic native process can choose paths dynamically and bypass Varin APIs. Portable filesystem
watchers report those changes after the write and cannot recreate bytes that were never observed before
the write. Varin therefore does not claim exact combined rollback for an unjournalled `bash`, terminal,
Git, extension, or unrelated-process change. The watcher records affected paths as uncovered; a turn
with incomplete observation cannot claim full coverage. Journalled paths can remain restorable under
partial coverage. Conversation-only rollback does not depend on file coverage.

Improving this boundary requires a real mechanism—Documents/VFS pre-write integration, a tool-declared
mutation intent, a copy-on-write filesystem provider, or operating-system interception. Reintroducing a
full turn-start scan is not an acceptable fallback.

## Replaceability and remaining design targets

The public recovery service remains version 5, with capability-negotiated checkpoint, mutation,
combined recovery, operation, retention and storage-management methods. Fixed Host code owns identity,
path admission, Documents coordination and Pi navigation; a selected provider owns its advertised
recovery implementation. Disabling it never removes Pi-native conversation rollback.

Public service version and private catalog format are separate. The production Rust catalog has no
v4-to-v5 migration path: obsolete internal formats are recreated under the kernel lock; corrupt,
unknown or future formats fail. Workspace files, Git, native Pi data and external configuration are
outside that recreation. The old local-SQLite migration narrative belongs to retired implementation
history, not the current provider contract.

Two earlier accepted improvements are still **design targets**, not current combined-restore behavior:

- Restore through an affected dirty buffer after confirmation, preserving that buffer for undo. The
  current journal engine reports the conflict but requires saving or discarding the buffer first
- Degrade an unresponsive surface into a confirmable `unknown-dirty-state` conflict. The current engine
  returns retryable `dirty-state-unavailable` when synchronization or inspection cannot establish state

These targets do not authorize bypassing the current barrier. See `validateConflicts` and `dirtyBarrier`
in [journal-engine.ts](../../packages/web/application-host/lib/recovery/journal-engine.ts).
Storage transfer/retention features of replacement providers likewise cannot be inferred from a v5 label.

## Verification

Useful behavior evidence follows the affected paths and actual authority:

- an unchanged turn opens and settles without a recursive file scan
- repeated journalled writes preserve the first before-state and final after-state
- partial coverage restores only supported paths and reports unjournalled shell/external paths
- changed paths, dirty buffers and unavailable surface state retain distinct failures
- interrupted apply or failed Pi navigation compensates only this operation's unchanged outputs
- pending operations and retained results prevent premature object collection
- platform replacement, Unicode/case, symlink and locked-file behavior use native evidence

Production tests must exercise the Rust adapter rather than the retired TS database fixture. Installed
runtime, power loss, model quality and other platform runs need their own evidence. Delivery results
remain in [status](../status.md) and existing acceptance records; this design is not a test-run receipt.

## Native process writers (D-280)

R4 registers actual process-tree ownership with the same Rust file-resource boundary. Deleting or
materializing an ancestor of a live/unknown cwd is denied. Process kill is only a request; exit
receipts, not closed protocol sockets or missing Host handles, release that protection. Recovery
and Registry retain their prior responsibilities. See [process ownership](../../packages/web/application-host/lib/process/DOCUMENTATION.md).
