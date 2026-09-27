# Recovery and rollback

Varin provides two related actions from every recoverable message:

- **conversation only** moves Pi's native session branch and restores editable prompt text/images;
- **conversation and files** also reverses the exact `write` and `edit` changes made by the turns that
  leave the active branch.

The default can be set to conversation only, conversation and files, or always ask.

Combined rollback uses affected-file checkpoints. It does not scan, copy, reset, or clean the complete
workspace when a session opens or a message is sent. If the recorded files have not changed again,
rollback runs directly from the message action. A chooser appears only for a real conflict, incomplete
external/shell coverage, or the always-ask preference.

Varin saves the current versions of affected paths before applying a rollback, so a completed recovery
can be undone. Recovery storage can use the application data directory, a workspace-local directory, a
sibling directory, or a custom root. Project selection overrides the global default; Settings also owns
verified migration, unreachable-object cleanup, and explicit workspace-history deletion.

Settings can also configure independent limits for automatic checkpoints, completed recovery operations,
logical history size, and age. Empty fields mean no limit; Varin does not impose a guessed default.
Named checkpoints and unfinished or attention-required recovery evidence are never removed by retention.
Pruning an automatic checkpoint removes that older file-rollback point; pruning a completed recovery
operation removes its undo evidence. Neither action removes Pi conversation history.
Connected editors publish and fence their latest unsaved state before affected files are inspected or
restored.

Pi remains the conversation authority. `pi-workspace-history` and `pi-wtf` are optional Pi packages and
are not installed or invoked by native Varin recovery.

Arbitrary native commands do not expose a portable pre-write file list. A turn whose `bash`, terminal,
Git, extension, or unrelated process changed unjournalled paths is marked incomplete for file rollback;
Varin does not hide that gap behind a slow full-workspace fallback. Conversation-only rollback remains
available.

The complete mechanism and provider contract are documented in
[Varin native recovery journal](native-workspace-recovery-design.md).
