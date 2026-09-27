# Varin native recovery journal

Status: built-in kernel provider delivered; Rust system-kernel Stage R complete through D-282.

Last updated: 2026-09-15

## Decision

Varin owns combined conversation and file rollback through the selected versioned
`varin.workspace-recovery` Host service. Pi remains authoritative for its append-only conversation
tree. The official provider is the statically distributed, replaceable
`varin.builtin.recovery` extension; it is not a Pi package or a separately published application
package.

The recovery unit is an affected-file change set. A message checkpoint is not a complete manifest of
the workspace and does not schedule a background archive.

D-252 accepts the [Rust system-kernel stage](rust-kernel-design.md) as the implementation owner of the built-in
provider's file resources, content/reference storage, and recovery operations. D-274/D-275 completed the R1
metadata cutover: immutable roots/objects/revisions and typed Recovery/Integration/agent-mutation records have
one Rust durable writer. D-276 completed the R2 file-resource cutover: affected-path capture, conditional
apply/compensation, exact/subtree overlap leases and restart reconciliation use the Rust file authority.
The public recovery service and affected-path semantics remain; Document Registry remains the mutable buffer
owner and Pi remains the conversation owner. Current milestone evidence is recorded in
[status.md](../status.md) and [agent-harness-plan.md](../plan/agent-harness-plan.md).
D-282 completes the surrounding R0/R6 release boundary: production artifacts carry the manifest-verified
kernel, the old TS file writer is test-only, and the cross-domain Registry+disk apply/undo vertical runs
against the real Rust storage/file/recovery authority.

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

When all affected paths still equal their recorded after-state, combined rollback executes directly.
The normal UI does not open a restore planner.

The chooser appears only when:

- the user selected **always ask**;
- an affected path was edited again or has an unsaved buffer;
- the turn contains unjournalled external/shell changes.

It offers the relevant decision only: restore the affected paths, return the conversation alone, or
cancel. There is no normal new-workspace mode.

### Redo

Before applying the inverse change set, Varin records the current state of those affected paths. That
small safety set drives operation compensation and explicit undo/redo. No full safety snapshot is
created.

## Capture protocol

The Web Host advertises `HostHandshakeParams.capabilities.workspaceMutationJournal`. A Pi worker enables
the bridge only when this value is explicitly true, so other Pi Hosts cannot be left waiting for an
acknowledgement they do not implement.

When enabled, Varin supplies same-name custom definitions for Pi's built-in `write` and `edit` tools.
They reuse Pi's original schemas, rendering, validation, and execution. Only the execution boundary is
wrapped:

```text
tool execute
  -> workspace.mutation.request(before, absolute path)
  -> Host stores path before-image and acknowledges
  -> original Pi tool executes
  -> workspace.mutation.request(after, outcome)
  -> Host stores final path state and acknowledges
  -> tool result continues
```

Requests are isolated by request ID and tool-call ID. A provider failure acknowledges `false` and lets
the tool continue; the turn checkpoint becomes incomplete instead of breaking the agent. Session
replacement or worker disposal releases all pending requests.

The first before-image and final after-image are authoritative when one path is written repeatedly in a
turn. A write that returns the file to its original state removes its change record.

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

The v5 replacement-provider contract retains the four optional locations below when a provider advertises
`storageManagement: true`:

| Mode | Replacement-provider location |
| --- | --- |
| application data | provider storage below `VARIN_DATA_DIR` |
| workspace local | `<workspace>/.varin/recovery/v1` |
| workspace adjacent | `<workspace-parent>/.varin-recovery/<workspaceId>/v1` |
| custom | `<selected-root>/<authorityId>/<workspaceId>/v1` |

For such a provider, project choice overrides its global default and verified transfer switches its own
registry only after the destination is readable. Cleanup remains provider-owned. Optional per-workspace
retention limits cover automatic checkpoint count, completed-operation
count, logical history bytes, and age. No guessed limit is enabled by default; when configured, the rule
runs after settled turns. Named checkpoints, pending checkpoints, unfinished operations, and
`needs-attention` evidence are protected. Deleting workspace history remains an explicit destructive
action. Status reports the oldest protected operation so an unresolved record cannot become an invisible
permanent pin.

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

Every content-object/journal write takes a shared durable workspace lease. Restore, compensation,
retention, deletion, storage transfer, and crash reconciliation take an exclusive lease for the complete
logical operation. The lease is a sidecar of the selected storage root, so independent Hosts that share a
workspace-local catalog coordinate across processes. Only a confirmed-dead PID is reclaimed; permission
or platform liveness uncertainty keeps the fence.

## External and shell boundary

A generic native process can choose paths dynamically and bypass Varin APIs. Portable filesystem
watchers report those changes after the write and cannot recreate bytes that were never observed before
the write. Varin therefore does not claim exact combined rollback for an unjournalled `bash`, terminal,
Git, extension, or unrelated-process change. The watcher records the affected path; today that marks the
whole turn incomplete, and under revision R1 it marks only that path uncovered while journaled paths stay
restorable. Conversation-only rollback remains immediate in both cases.

Improving this boundary requires a real mechanism—Documents/VFS pre-write integration, a tool-declared
mutation intent, a copy-on-write filesystem provider, or operating-system interception. Reintroducing a
full turn-start scan is not an acceptable fallback.

## Replaceability

The service contract is version 5. A replacement provider implements the same checkpoint, mutation,
combined recovery, operation, retention, and storage-management methods. Fixed Host code owns workspace identity,
path containment, the negotiated Pi tool boundary, and Pi conversation navigation. Provider code owns
the catalog, content objects, change-set folding, conflict policy, and UI contributions.

Version 4 adds: per-file `operation_files` phase tracking (pending → apply-intent → target-observed →
compensate-intent → safety-observed, with needs-attention as a blocking terminal), crash-window
reconciliation in `resumeUnfinished` that compares on-disk state against target/safety before deciding
to abort or compensate, confirmed-conflict-only `overwrite-confirmed` policy, scoped workspace-history
deletion via row-level SQL instead of removing the storage root, and a read-only
`inspectRecoveryJournalCatalog` path for status and inspection that never runs migrations or schema
writes.

Version 5 adds the cross-surface dirty-state barrier, shared/exclusive process-owned workspace leases,
configurable retention with protected record classes, and workspace-scoped `object_references` that are
maintained in the same database transactions as checkpoints and operations. Catalog v4 activates through
a transactional v5 migration that rebuilds those references; read-only status inspection still does not
activate or migrate a catalog.

Provider selection remains revisioned and scope-aware. Disabling a provider removes file recovery but
never removes Pi-native conversation rollback.

## Accepted boundary revisions

A design review on 2026-09-02 found the core architecture sound — affected-file journal, tool-boundary
before/after images, content-addressed objects, verify-after-write, compensation, direct apply on the
happy path — and the defensiveness concentrated at four boundaries where a fail-closed default produces
refusal instead of partial success. The revisions below are accepted and ordered by delivery. None
changes the per-file state machine, the catalog schema versioning rules, or the compensation model.

### R1. Coverage is per path, not per plan (implemented 2026-09-03)

The plan-level `coverage: 'ready' | 'incomplete'` binary is replaced by per-path coverage. A path with a
contiguous journaled before/after chain is restorable. A path observed only by the watcher, or inferred
from a `process` writer window, is reported in `uncoveredPaths` with its source (`shell`, `external`,
`unknown`) and is not restored. The combined action remains available whenever at least one path is
restorable; the direct-apply result and the chooser both list the uncovered paths.

The `coverage` field is now `'ready' | 'partial' | 'none'`:
- `ready` — all checkpoints in range are `ready` (no incomplete checkpoint, no uncovered paths)
- `partial` — some paths are restorable, but at least one checkpoint is incomplete or has uncovered paths
- `none` — no restorable paths (all changes were unjournaled or no journaled changes exist)

A checkpoint is `incomplete` when the turn settles without confirmed coverage (`observationComplete=false`,
worker exit, host stop, or out-of-journal activity). An incomplete checkpoint with empty
`unrecorded_resource_ids` still disqualifies `ready` because the journal cannot prove it captured
everything. The failure message from each incomplete binding is collected into `uncoveredReasons: string[]`
on the plan so the UI can show why coverage is not `ready`.

Source attribution uses the `writerScope` format `${mode}/${kind}:${id}@gen`:
- `process/` prefix → `shell`
- `external/` prefix → `external`
- any other prefix or legacy format without a mode → `unknown`

`applyLocatedOperation` rejects only when `coverage === 'none'`. The `PiRecoveryDialog` shows the
uncovered paths list with source attribution and the uncovered reasons, and offers the combined action
for `ready` and `partial` plans. The `piRecoveryPolicy.shouldOpenRecoveryDialog` opens the dialog for any
non-`ready` plan.

Rationale: the agent harness registers its `bash` tool as a `process` writer for every command
([agent-harness.md](agent-harness.md) §5.2). Under the binary rule nearly every turn that runs a
command becomes incomplete and combined rollback disappears in practice. The host shell supervisor
knows each command's execution window, so watcher changes inside that window are attributed to the
command; attribution improves, restoration of those paths does not. This revision is a prerequisite
for harness phase 1.

### R2. Dirty buffers are conflicts, not refusals

The `dirty-buffers` hard rejection in conflict confirmation is removed. A dirty buffer on an affected
path becomes a `dirty-buffer` conflict the user confirms like a content conflict. On confirmation the
buffer content published through the barrier is stored in the operation's safety set, so undo restores
the unsaved text, and the path is then replaced on disk. Connected surfaces observe the disk change
through the existing watch; the Document Registry presents its three-way conflict when the buffer was
not discarded. The chooser may additionally offer "discard unsaved changes in these paths".

Rationale: the current rejection is a shipped TODO ("not yet implemented") and duplicates protection
the Document Registry already provides by modelling ancestor plus disk against the live buffer.

### R3. The dirty barrier degrades per surface

An unresponsive or disconnected document surface no longer fails the operation with
`dirty-state-unavailable`. Surfaces that acknowledge are fenced as today. Each surface that does not
acknowledge within the deadline contributes an `unknown-dirty-state` conflict for the affected paths it
may hold, which the user can confirm. The retryable hard failure remains only when the barrier primitive
itself is unavailable.

Rationale: a mobile client that went to sleep while attached must not block a desktop rollback.

### R4. The lease is scoped to shared storage

The cross-process workspace lease applies only to storage modes that can be shared between Hosts:
workspace local, workspace adjacent, and custom. The default application-data mode is single-Host and
takes no lease. In shared modes, lease holders refresh a heartbeat; a lease whose PID liveness cannot be
confirmed is reclaimed after the heartbeat window instead of being fenced indefinitely.

Rationale: `process.kill(pid, 0)` commonly returns `EPERM` on Windows, which the current rule treats as
"keep the fence". One crashed Host could pin a workspace until manual intervention, protecting against a
two-Host overlap that cannot occur in the default mode.

### R5. Retry re-prepares

After a `stale-plan` failure the chooser's retry prepares a new plan and revision instead of re-applying
the stale one, which cannot succeed.

### R6. Scope freeze

No further storage location modes, retention dimensions, or per-file phases are added. The six-phase
file state machine, verified storage transfer, and retention with protected record classes stay as built
and tested; they are not refactored for size.

### R7. Single per-path edit record shared with the knowledge store

The harness knowledge store's `edit` events reference journal before/after content objects instead of
storing a second copy of the change ([agent-harness.md](agent-harness.md) §7.3). The journal remains
the only per-path edit record. Knowledge-store references are registered in `object_references` so
cleanup and retention never remove an object the knowledge store still points to.

## Verification

Required evidence is based on affected paths, not synthetic full-workspace archives:

- a no-op turn opens, settles, and rolls back without reading any workspace file;
- a large workspace with one touched file reads only that file;
- repeated writes retain the first before-image and final after-image;
- later user edits produce a per-path conflict and are not overwritten under `abort`;
- explicit overwrite stores a redo state before replacing the affected path;
- interrupted multi-path apply compensates only completed paths;
- stale Pi leaf navigation compensates files and does not report success;
- unjournalled shell paths produce an incomplete checkpoint rather than a scan;
- Windows replacement, Unicode/case paths, symlinks, read-only files, and locked paths retain explicit
  tested outcomes;
- storage migration verifies before switching and cleanup never removes a referenced object.
- two Hosts sharing workspace-local storage cannot overlap an exclusive restore with journal/object work;
- dirty revisions from all connected surfaces are acknowledged before file inspection and remain fenced
  through apply;
- retention removes oldest eligible records while preserving named and nonterminal recovery evidence.

Evidence required by the accepted revisions:

- a turn with one journaled path and one shell-written path offers restoration of the journaled path and
  reports the shell-written path as uncovered with its source (R1);
- a dirty buffer on an affected path is presented as a confirmable conflict; after confirmation, undo
  restores the unsaved text from the safety set (R2);
- a surface that does not acknowledge the barrier produces an `unknown-dirty-state` conflict rather than
  an operation failure; the operation completes for acknowledged surfaces (R3);
- application-data storage creates no lease file; in a shared mode an uncertain PID is reclaimed after
  the heartbeat window and a live holder is not (R4);
- retry after `stale-plan` produces a new plan revision (R5);
- an object referenced only by the knowledge store survives cleanup and retention (R7).

## Native process writers (D-280)

R4 registers actual process-tree ownership with the same Rust file-resource boundary. Deleting or
materializing an ancestor of a live/unknown cwd is denied. Process kill is only a request; exit
receipts, not closed protocol sockets or missing Host handles, release that protection. Recovery
and Registry retain their prior responsibilities. See [process ownership](../../packages/web/application-host/lib/process/DOCUMENTATION.md).
