# Recovery and rollback

Varin provides a file timeline alongside conversation-only and combined conversation/file recovery.
Every file operation uses its original resource Host and worktree. Native conversation recovery navigates
the original HistoryBranch.

## Choose the scope

- **Conversation only** changes the selected history branch and restores the relevant editable input.
- **Conversation and files** also prepares the recorded path changes for entries leaving that branch.
  The preview shows real conflicts, incomplete coverage and unavailable owners.
- **Files only**, in the Recovery panel, restores all or selected recorded paths to a round's start,
  its end, or a named point. The conversation stays active. Naming a point saves the current content
  of paths already recorded by that conversation.

The conversation navigation default can be conversation only, conversation and files, or always ask.
The file timeline groups internal input records into complete conversation rounds and updates when
the Run ends. Read-only rounds add no empty point.

The sidebar opens rounds in place. Select the start or end, choose files, and open a file to see
the difference from its current content to the selected version. Content is read only when opened;
large previews can load further pages. The footer reports each restore and offers undo. The menu
contains named points, restore history, and storage details for the original resource Host.

Agents receive `recovery_points` and `file_restore` as resident tools in physical workspaces with
the corresponding file permissions. The former lists points, inspects affected paths and observes
an original restore operation. The latter accepts a point, `current:before`, or an operation to undo.
It returns per-file outcomes; a conflicting file does not prevent other files from being restored.

Controlled file tools retain before/after evidence. Arbitrary commands, Git or external applications
can change unjournalled files, so their file coverage can be incomplete. Conversation-only recovery
remains available; a broad workspace scan cannot manufacture missing before-images.

## Conflicts, drafts and undo

Recovery compares each affected path with the output it recorded. Later user edits are reported
per file and can be explicitly overwritten. Connected editors publish/fence their actual dirty revision.
File-only recovery leaves unsaved drafts intact and reports those paths for attention, while other
files proceed. Combined recovery retains confirmed buffer text and its disk base through the original
Surface transaction.

Before applying, the owner saves safety/redo objects for affected paths. A completed operation can be
undone when its retained evidence and current path conditions allow. Interrupted or unknown operations
reuse their original IDs and receipts after reconnect; do not start a second attempt merely because the
first response was lost. Compensation changes only the operation's own still-unchanged outputs.

Managed multi-Host recovery displays the actual target Hosts. Each keeps its own file journal and
permissions; the conversation Host coordinates their receipts before navigating. This is recoverable
coordination, not an atomic rollback across machines. An offline owner or unconfirmed stop can leave an
operation pending or needing attention.

## Storage capabilities

The built-in provider shares the Host kernel data root with WorkingState. The panel reports the
workspace's deduplicated retained recovery objects; Host-wide catalog/WAL totals remain in global
storage information. Remove a point from its menu to release its history. Records still needed by
older points or undo operations stay referenced until those owners are removed. GC then reclaims
unreferenced objects. There is no automatic retention cap or built-in storage relocation.

Replacement recovery providers can advertise other storage modes and management capabilities; the UI
shows controls only when the selected provider supports them. The original journal and resource owners
remain authoritative; a replacement provider does not authorize access to unrelated data.

The [resource contract](../resources.md#受影响文件恢复) explains the mechanism; the
[Recovery module](../../packages/web/application-host/lib/recovery/DOCUMENTATION.md) maps it to code.
