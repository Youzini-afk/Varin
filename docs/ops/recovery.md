# Recovery and rollback

Varin exposes conversation-only recovery and, where affected-file coverage is available, combined
conversation/file recovery. Pi conversations navigate their native session tree; Agent Threads navigate
their own HistoryBranch. Recovery does not import one runtime's history into the other.

## Choose the scope

- **Conversation only** changes the selected history branch and restores the relevant editable input.
- **Conversation and files** also prepares the recorded path changes for entries leaving that branch.
  The preview shows real conflicts, incomplete coverage and unavailable owners.

The default can be conversation only, conversation and files, or always ask. A new turn creates only
an affected-file checkpoint; it does not scan, copy, reset or clean the whole workspace.

Controlled file tools retain before/after evidence. Arbitrary commands, Git or external applications
can change unjournalled files, so their file coverage can be incomplete. Conversation-only recovery
remains available; a broad workspace scan cannot manufacture missing before-images.

## Conflicts, drafts and undo

Recovery compares each affected path with the output it recorded. Later user edits are conflicts,
not permission to overwrite. Connected editors publish/fence their actual dirty revision. Confirmed
buffer recovery retains its text and disk base through the original Surface transaction. A disconnected
or unknown dirty state remains unavailable even if the user is willing to proceed.

Before applying, the owner saves safety/redo objects for affected paths. A completed operation can be
undone when its retained evidence and current path conditions allow. Interrupted or unknown operations
reuse their original IDs and receipts after reconnect; do not start a second attempt merely because the
first response was lost. Compensation changes only the operation's own still-unchanged outputs.

Managed multi-Host recovery displays the actual target Hosts. Each keeps its own file journal and
permissions; the conversation Host coordinates their receipts before navigating. This is recoverable
coordination, not an atomic rollback across machines. An offline owner or unconfirmed stop can leave an
operation pending or needing attention.

## Storage capabilities

The built-in provider shares the Host kernel data root with WorkingState. It reports application-data
storage and does not currently provide relocation, retention settings or delete-history controls.
Shared catalog/WAL totals are not per-workspace reclaimable history. GC respects other retained result,
branch and operation owners and reports actual cleanup failures.

Replacement recovery providers can advertise other storage modes and management capabilities; the UI
shows controls only when the selected provider supports them. Optional Pi packages such as
`pi-workspace-history` and `pi-wtf` have their own commands/data and are not invoked by this recovery path.

The [resource contract](../resources.md#受影响文件恢复) explains the mechanism; the
[Recovery module](../../packages/web/application-host/lib/recovery/DOCUMENTATION.md) maps it to code.
